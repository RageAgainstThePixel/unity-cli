// Minimal mock for @electron/asar used in tests
module.exports = {
    extractFile: (asarPath, file) => {
        if (file === 'package.json') {
            return Buffer.from(JSON.stringify({ version: '1.0.0' }));
        }
        return Buffer.from('');
    }
};
