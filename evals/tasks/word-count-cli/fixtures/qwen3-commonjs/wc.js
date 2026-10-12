const fs = require('fs');
const path = require('path');

if (process.argv.length !== 3) {
    console.error('Usage: node wc.js <file>');
    process.exit(1);
}

const filePath = process.argv[2];
try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = (content.match(/\n/g) || []).length;
    const words = content.split(/\s+/).filter(Boolean).length;
    const chars = content.length;
    console.log(JSON.stringify({ lines, words, chars }));
} catch (err) {
    if (err.code === 'ENOENT') {
        console.error(`Error: File not found: ${filePath}`);
        process.exit(1);
    } else {
        console.error('An error occurred:', err.message);
        process.exit(1);
    }
}