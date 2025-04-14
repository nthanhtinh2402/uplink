require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const clipboardy = require('clipboardy');
const crypto = require('crypto');
const url = require('url');
const ora = require('ora');
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
    const parsedUrl = new URL(productUrl);
    console.log('Parsed URL:', parsedUrl);
    return parsedUrl;
}

async function loginIfNeeded(page) {
    const spinner = ora('🔐 Checking login status...').start();

    try {
        await page.goto('https://elements.envato.com/sign-in', { 
            waitUntil: 'domcontentloaded', 
            timeout: 60000 
        });

        const isLoggedIn = await page.$('a[href="/profile"]');
        if (isLoggedIn) {
            spinner.succeed('✅ Already logged in!');
            return true;
        }

        spinner.text = '🔑 Entering login credentials...';
        await page.waitForSelector('input[name="username"]', { 
            visible: true, 
            timeout: 10000 
        });
        
        const username = process.env.ENVATO_USERNAME;
        const password = process.env.ENVATO_PASSWORD;

        if (!username || !password) {
            throw new Error("Missing ENVATO_USERNAME or ENVATO_PASSWORD in .env");
        }

        await page.type('input[name="username"]', username, { delay: 60 });
        await page.waitForSelector('input[name="password"]', { 
            visible: true, 
            timeout: 10000 
        });
        await page.type('input[name="password"]', password, { delay: 60 });

        await page.keyboard.press('Enter');
        await page.waitForNavigation({ 
            waitUntil: 'domcontentloaded', 
            timeout: 60000 
        });

        spinner.succeed('✅ Login successful!');
        return true;
    } catch (error) {
        spinner.fail('❌ Login failed!');
        console.error("Login error:", error);
        return false;
    }
}

async function autoClickByText(page, textVariations = ['Download', 'Tải xuống', 'Download Now']) {
    const spinner = ora('🤖 Using AI to detect button...').start();
    
    try {
        const screenshotBuffer = await page.screenshot({ 
            fullPage: true,
            encoding: 'binary'
        });

        const processedImage = await sharp(screenshotBuffer)
            .greyscale()
            .normalise()
            .linear(1.2, -15)
            .sharpen()
            .threshold(150)
            .toBuffer();

        const { data: { words } } = await Tesseract.recognize(processedImage, 'eng', {
            logger: m => spinner.text = `🤖 ${m.status} (${Math.round(m.progress * 100)}%)`,
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
            preserve_interword_spaces: '1',
            tessedit_pageseg_mode: '6',
            tessedit_ocr_engine_mode: '3'
        });

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
                
                spinner.succeed(`✅ Detected and clicked '${bestMatch.text}' (Accuracy: ${bestMatch.confidence}%)`);
                return true;
            }
        }
        
        spinner.fail("❌ Couldn't find matching button");
        return false;
    } catch (error) {
        spinner.fail('❌ AI detection error');
        console.error("OCR Error:", error);
        return false;
    }
}

async function clickAndDownload(page) {
    let downloadLink = null;
    const spinner = ora('📦 Processing download button...').start();
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

        for (let sel of selectors) {
            try {
                const btn = await page.$(sel);
                if (btn) {
                    await btn.click();
                    found = true;
                    spinner.text = `📦 Found button using selector: ${sel}`;
                    break;
                }
            } catch (error) {
                console.log(`Couldn't click using selector ${sel}:`, error.message);
            }
        }

        if (!found) {
            spinner.text = '🔎 No selector found, using AI OCR...';
            found = await autoClickByText(page);
        }

        if (!found) {
            throw new Error("Couldn't find Download button");
        }

        await new Promise(r => setTimeout(r, 2000));
        const downloadWithoutLicenseButton = await page.$('[data-testid="download-without-license-button"]');
        if (!downloadWithoutLicenseButton) {
            throw new Error("Couldn't find 'Download without license' button");
        }

        await page.setRequestInterception(true);
        page.removeAllListeners('request');
        page.removeAllListeners('response');

        responseListener = (response) => {
            const requestUrl = response.url();
            if (requestUrl.includes('https://') && response.request().resourceType() === 'document') {
                downloadLink = requestUrl;
                clipboardy.writeSync(downloadLink);
                spinner.succeed(`✅ Download link: ${downloadLink}`);
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
        spinner.fail(`❌ Download error: ${error.message}`);
        throw error;
    } finally {
        try {
            if (responseListener) page.off('response', responseListener);
            if (requestListener) page.off('request', requestListener);
            await page.setRequestInterception(false);
        } catch (cleanupError) {
            console.error('Cleanup error:', cleanupError);
        }
        spinner.stop();
    }
}

async function getDownloadLink(productUrl) {
    const progress = new cliProgress.SingleBar({
        format: '🚀 Processing: [{bar}] {percentage}% | {value}/{total} steps',
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

        await page.goto(productUrl, { 
            waitUntil: 'domcontentloaded', 
            timeout: 60000 
        });
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
            res.send('❌ No download link found.');
        }
    } catch (err) {
        console.error("❌ Processing error:", err);
        res.status(500).send('❌ An error occurred during processing.');
    } finally {
        isProcessing = false;
        processQueue();
    }
}

app.get('/getlink', (req, res) => {
    const productUrl = req.query.url;
    if (!productUrl) {
        return res.status(400).send('❌ Missing ?url parameter');
    }

    requestQueue.push({ productUrl, res });
    processQueue();
});

(async () => {
    // Mobile configuration for iPhone 12
    const mobileDevice = {
        viewport: {
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
            isLandscape: false
        },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
    };

    browser = await puppeteer.launch({ 
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            `--user-agent=${mobileDevice.userAgent}`
        ],
        protocolTimeout: 60000
    });
    
    page = await browser.newPage();
    await page.emulate(mobileDevice);

    const loggedIn = await loginIfNeeded(page);
    if (!loggedIn) {
        await browser.close();
        process.exit(1);
    }

    app.listen(port, () => {
        console.log(`🚀 Server running at http://localhost:${port} (Mobile Mode)`);
    });

    process.on('SIGINT', async () => {
        await browser.close();
        process.exit(0);
    });
})();
