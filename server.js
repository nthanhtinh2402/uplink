require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const clipboardy = require('clipboardy');
const crypto = require('crypto');
const url = require('url');
const ora = require('ora').default;
const cliProgress = require('cli-progress');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

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

// 🧠 Enhanced AI OCR Function
async function autoClickByText(page, textVariations = ['Download', 'Tải xuống', 'Download Now']) {
    const spinner = ora('🤖 Đang sử dụng AI để nhận diện nút...').start();
    
    try {
        // Capture and pre-process screenshot
        const screenshotBuffer = await page.screenshot({ 
            fullPage: true,
            encoding: 'binary'
        });

        // Image processing for better OCR accuracy
        const processedImage = await sharp(screenshotBuffer)
            .greyscale()
            .normalise()
            .linear(1.2, -15)
            .sharpen()
            .threshold(150)
            .toBuffer();

        // OCR with optimized configuration
        const { data: { words } } = await Tesseract.recognize(processedImage, 'eng', {
            logger: m => spinner.text = `🤖 ${m.status} (${Math.round(m.progress * 100)}%)`,
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
            preserve_interword_spaces: '1',
            tessedit_pageseg_mode: '6',
            tessedit_ocr_engine_mode: '3'
        });

        // Try each text variation
        for (const text of textVariations) {
            const matches = words.filter(w => 
                w.text.toLowerCase().includes(text.toLowerCase()) && 
                w.confidence > 70
            );

            if (matches.length > 0) {
                const bestMatch = matches.reduce((prev, current) => 
                    (prev.confidence > current.confidence) ? prev : current
                );
                
                const x = bestMatch.bbox.x0 + (bestMatch.bbox.x1 - bestMatch.bbox.x0) / 2;
                const y = bestMatch.bbox.y0 + (bestMatch.bbox.y1 - bestMatch.bbox.y0) / 2;
                
                await page.evaluate((x, y) => {
                    window.scrollTo({
                        left: x - window.innerWidth/2,
                        top: y - window.innerHeight/2,
                        behavior: 'smooth'
                    });
                }, x, y);
                
                await new Promise(resolve => setTimeout(resolve, 500));
                await page.mouse.click(x, y);
                
                spinner.succeed(`✅ Đã nhận diện và click '${bestMatch.text}' (Độ chính xác: ${bestMatch.confidence}%)`);
                return true;
            }
        }
        
        spinner.fail("❌ Không thể tìm thấy nút phù hợp");
        return false;
    } catch (error) {
        spinner.fail('❌ Lỗi trong quá trình nhận diện AI');
        console.error("OCR Error:", error);
        return false;
    }
}

async function clickAndDownload(page) {
    let downloadLink = null;
    const spinner = ora('📦 Đang xử lý nút tải xuống...').start();
    let responseListener, requestListener;

    try {
        let found = false;
        const selectors = [
            '[data-testid="button-download-psd"]',
            '[data-testid="button-download"]',
            '[data-testid="button-download-3d"]',
            'button[aria-label*="Download"]',
            'a.download-button',
            'button:has-text("Download")'
        ];

        // Try standard selectors first
        for (let sel of selectors) {
            try {
                const btn = await page.$(sel);
                if (btn) {
                    await btn.click();
                    found = true;
                    spinner.text = `📦 Đã tìm thấy nút bằng selector: ${sel}`;
                    break;
                }
            } catch (error) {
                console.log(`Không thể click bằng selector ${sel}:`, error.message);
            }
        }

        // Fallback to AI OCR if selectors fail
        if (!found) {
            spinner.text = '🔎 Không tìm thấy nút bằng selector, đang sử dụng AI OCR...';
            found = await autoClickByText(page);
        }

        if (!found) {
            throw new Error("Không thể tìm thấy nút Download");
        }

        await new Promise(r => setTimeout(r, 2000));
        const downloadWithoutLicenseButton = await page.$('[data-testid="download-without-license-button"]');
        if (!downloadWithoutLicenseButton) {
            throw new Error("Không tìm thấy nút 'Download without license'");
        }

        await page.setRequestInterception(true);
        page.removeAllListeners('request');
        page.removeAllListeners('response');

        responseListener = (response) => {
            const requestUrl = response.url();
            if (requestUrl.includes('https://') && response.request().resourceType() === 'document') {
                downloadLink = requestUrl;
                clipboardy.writeSync(downloadLink);
                spinner.succeed(`✅ Link tải: ${downloadLink}`);
            }
        };

        requestListener = (request) => {
            const requestUrl = request.url();
            if (requestUrl.includes('https://') && request.resourceType() === 'document') {
                downloadLink = requestUrl;
                request.abort();
            } else {
                request.continue();
            }
        };

        page.on('response', responseListener);
        page.on('request', requestListener);

        await downloadWithoutLicenseButton.click();
        await new Promise(resolve => setTimeout(resolve, 5000));

        return downloadLink;
    } catch (error) {
        spinner.fail(`❌ Lỗi khi tải xuống: ${error.message}`);
        throw error;
    } finally {
        try {
            if (responseListener) page.off('response', responseListener);
            if (requestListener) page.off('request', requestListener);
            await page.setRequestInterception(false);
        } catch (cleanupError) {
            console.error('Lỗi khi dọn dẹp:', cleanupError);
        }
        spinner.stop();
    }
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
    } catch (err) {
        console.error("❌ Lỗi khi xử lý:", err);
        res.status(500).send('❌ Có lỗi xảy ra trong quá trình xử lý.');
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
    processQueue();
});

(async () => {
    browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const loggedIn = await loginIfNeeded(page);
    if (!loggedIn) {
        await browser.close();
        process.exit(1);
    }

    app.listen(port, () => {
        console.log(`🚀 Server lắng nghe tại http://localhost:${port}`);
    });

    process.on('SIGINT', async () => {
        await browser.close();
        process.exit(0);
    });
})();