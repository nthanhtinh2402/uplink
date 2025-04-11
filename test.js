require('dotenv').config();
const express = require('express');
const fs = require('fs');
const app = express();
const port = 3000;

// Middleware log mỗi request
app.use((req, res, next) => {
    console.log(`📡 [${new Date().toLocaleString()}] ${req.method} ${req.originalUrl}`);
    next();
});

app.get('/getlink', (req, res) => {
    const productUrl = req.query.url || '';
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Ghi log
    const logEntry = `[${new Date().toISOString()}] IP: ${clientIp} | URL: ${productUrl}\n`;
    fs.appendFileSync('logs.txt', logEntry);

    // Trả về đúng link người dùng gửi
    res.send(productUrl);
});

app.listen(port, () => {
    console.log(`✅ Server lắng nghe tại http://localhost:${port}/getlink`);
});
