const AWS = require('aws-sdk');

module.exports = () => {
  const secretManager = new AWS.SecretsManager({ region: 'sa-east-1' });
  return new Promise((resolve, reject) => {
    secretManager.getSecretValue({ SecretId: 'arn:aws:secretsmanager:sa-east-1:244807945617:secret:env-8tdon8' }, (err, data) => {
      if (err) {
        reject(err);
      } else {
        const secret = JSON.parse(data.SecretString);
        const secretsString = Object.keys(secret).map(key => `${key}=${secret[key]}`).join('\n');
        resolve(secretsString);
      }
    });
  });
};
