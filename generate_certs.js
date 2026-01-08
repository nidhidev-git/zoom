const forge = require('node-forge');
const fs = require('fs');

console.log('Generating 2048-bit key-pair...');
const pki = forge.pki;
const keys = pki.rsa.generateKeyPair(2048);
const cert = pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
const attrs = [{ name: 'commonName', value: 'localhost' }];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.sign(keys.privateKey);

const pem = {
    private: pki.privateKeyToPem(keys.privateKey),
    cert: pki.certificateToPem(cert)
};

if (!fs.existsSync('certs')) {
    fs.mkdirSync('certs');
}
fs.writeFileSync('certs/key.pem', pem.private);
fs.writeFileSync('certs/cert.pem', pem.cert);
console.log('Certificates generated in certs/ folder');
