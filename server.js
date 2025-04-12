require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const clipboardy = require('clipboardy');
const crypto = require('crypto');
const url = require('url');
const ora = require('ora').default;
const cliProgress = require('cli-progress');

puppeteer.use(StealthPlugin());

const app = express();
const port = 3000;

let browser;
let page;
let isProcessing = false;
const requestQueue = [];

function generateHashFromUrl(productUrl) {
    return crypto.createHash('sha256').update(productUrl).digest('hex');
}

function parseProductUrl(productUrl) {
    const parsedUrl = url.parse(productUrl);
    console.log('Parsed URL:', parsedUrl);
    return parsedUrl;
}

async function loginIfNeeded(page) {
    const spinner = ora('🔐 Đang kiểm tra đăng nhập...').start();

    try {
        await page.goto('https://elements.envato.com/sign-in', { waitUntil: 'domcontentloaded', timeout: 60000 });

        const isLoggedIn = await page.$('a[href="/profile"]');
        if (isLoggedIn) {
            spinner.succeed('✅ Đã đăng nhập!');
            return true;
        }

        spinner.text = '🔑 Đang nhập thông tin đăng nhập...';
        await page.waitForSelector('input[name="username"]', { visible: true, timeout: 10000 });
        const username = process.env.ENVATO_USERNAME;
        const password = process.env.ENVATO_PASSWORD;

        if (!username || !password) throw new Error("Thiếu ENVATO_USERNAME hoặc ENVATO_PASSWORD trong .env");

        await page.type('input[name="username"]', username, { delay: 60 });
        await page.waitForSelector('input[name="password"]', { visible: true, timeout: 10000 });
        await page.type('input[name="password"]', password, { delay: 60 });

        await page.keyboard.press('Enter');
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });

        spinner.succeed('✅ Đăng nhập thành công!');
        return true;
    } catch (error) {
        spinner.fail('❌ Lỗi khi đăng nhập!');
        console.error("Login error:", error);
        return false;
    }
}

async function clickAndDownload(page) {
    let downloadLink = null;
    const spinner = ora('📦 Đang xử lý nút tải xuống...').start();

    let downloadButton = await page.$('[data-testid="button-download-psd"]');
    if (!downloadButton) {
        downloadButton = await page.$('[data-testid="button-download"]');
        if (!downloadButton) {
            downloadButton = await page.$('[data-testid="button-download-3d"]');
            if (!downloadButton) {
                spinner.fail("❌ Không tìm thấy nút 'Download'");
                return null;
            }
        }
    }

    spinner.text = '📥 Đang nhấn nút Download...';
    await downloadButton.click();
    await new Promise(resolve => setTimeout(resolve, 2000));

    const downloadWithoutLicenseButton = await page.$('[data-testid="download-without-license-button"]');
    if (!downloadWithoutLicenseButton) {
        spinner.fail("❌ Không tìm thấy nút 'Download without license'");
        return null;
    }

    await page.setRequestInterception(true);
    page.removeAllListeners('request');
    page.removeAllListeners('response');

    const responseListener = (response) => {
        const requestUrl = response.url();
        if (requestUrl.includes('https://') && response.request().resourceType() === 'document') {
            downloadLink = requestUrl;
            clipboardy.writeSync(downloadLink);
            spinner.succeed(`✅ Link tải: ${downloadLink}`);
        }
    };

    const requestListener = (request) => {
        const requestUrl = request.url();
        if (requestUrl.includes('https://') && request.resourceType() === 'document') {
            console.log(`⛔ Hủy tải xuống: ${requestUrl}`);
            downloadLink = requestUrl;
            request.abort();
        } else {
            request.continue();
        }
    };

    page.on('response', responseListener);
    page.on('request', requestListener);

    spinner.text = '⚡ Đang nhấn "Download without license"...';
    await downloadWithoutLicenseButton.click();
    await new Promise(resolve => setTimeout(resolve, 5000));

    page.off('response', responseListener);
    page.off('request', requestListener);
    await page.setRequestInterception(false);

    return downloadLink;
}

async function getDownloadLink(productUrl) {
    const progress = new cliProgress.SingleBar({
        format: '🚀 Đang xử lý: [{bar}] {percentage}% | {value}/{total} bước',
        barCompleteChar: '█',
        barIncompleteChar: '-',
        hideCursor: true
    }, cliProgress.Presets.shades_classic);

    const steps = 4;
    progress.start(steps, 0);

    try {
        const parsedUrl = parseProductUrl(productUrl);
        const hash = generateHashFromUrl(productUrl);
        console.log(`Product hash: ${hash}`);
        console.log(`URL: ${JSON.stringify(parsedUrl, null, 2)}`);
        progress.increment();

        await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        progress.increment();

        const link = await clickAndDownload(page);
        progress.increment();

        progress.stop();
        return link;
    } catch (error) {
        progress.stop();
        throw error;
    }
}

async function processQueue() {
    if (isProcessing || requestQueue.length === 0) return;

    isProcessing = true;
    const { productUrl, res } = requestQueue.shift();

    try {
        const downloadLink = await getDownloadLink(productUrl);
        if (downloadLink) {
            res.send(downloadLink);
        } else {
            res.send('❌ Không tìm thấy link tải.');
        }

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ Quá trình xử lý hoàn tất.');
        console.log(`📋 Còn lại ${requestQueue.length} yêu cầu trong hàng đợi`);
    } catch (err) {
        console.error("❌ Lỗi khi xử lý:", err);
        res.status(500).send('❌ Có lỗi xảy ra trong quá trình xử lý.');
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('⚠️  Kết thúc do lỗi.');
    } finally {
        isProcessing = false;
        processQueue();
    }
}

app.get('/getlink', (req, res) => {
    const productUrl = req.query.url;
    if (!productUrl) {
        return res.status(400).send('❌ Thiếu tham số ?url=');
    }

    requestQueue.push({ productUrl, res });
    console.log(`📥 Đã thêm yêu cầu vào hàng đợi. Hiện có ${requestQueue.length} yêu cầu.`);

    processQueue();
});

(async () => {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    page = await browser.newPage();
    await page.setViewport({
        width: 375,
        height: 812,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        isLandscape: false
    });

    const loggedIn = await loginIfNeeded(page);
    if (!loggedIn) {
        console.error("❌ Không thể đăng nhập Envato.");
        await browser.close();
        process.exit(1);
    }

    app.listen(port, () => {
        console.log(`🚀 Server lắng nghe tại http://localhost:${port}`);
    });

    process.on('SIGINT', async () => {
        await browser.close();
        console.log('Browser đã đóng.');
        process.exit(0);
    });
})();
