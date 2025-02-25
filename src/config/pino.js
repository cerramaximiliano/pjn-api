const pino = require('pino');
const path = require('path');
const moment = require("moment");
const filePath = path.join(__dirname, '../logs');
const fsPromises = require("fs").promises;

const levels = {
    emerg: 80,
    alert: 70,
    crit: 60,
    error: 50,
    warn: 40,
    notice: 30,
    info: 20,
    debug: 10,
};
const logger = pino({
    transport: {
        targets: [
            {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'dd-mm-yyyy, HH:MM:ss',
                    destinaction: 1
                }
            },
            {
                target: 'pino-pretty',
                options: {
                    colorize: false,
                    translateTime: 'dd-mm-yyyy, HH:MM:ss',
                    destination: `${filePath}/logger.log`
                }
            },
        ]
    },
},
);

async function cleanLogs(forceClear = false) {
    try {
        const logsDir = path.join(__dirname, '../../src/logs');
        const files = await fsPromises.readdir(logsDir);
        let filesProcessed = 0;

        logger.info(`Found ${files.length} files in logs directory`);

        for (const file of files) {
            if (file.endsWith('.log')) {
                const filePath = path.join(logsDir, file);
                const stats = await fsPromises.stat(filePath);
                const fileDate = moment(stats.mtime);
                const daysDiff = moment().diff(fileDate, 'days');

                logger.info(`Processing ${file} - Last modified: ${fileDate.format('YYYY-MM-DD HH:mm:ss')} (${daysDiff} days old)`);

                if (forceClear || daysDiff >= 1) {
                    const beforeSize = stats.size;
                    await fsPromises.truncate(filePath, 0);
                    const afterStats = await fsPromises.stat(filePath);

                    logger.info(`File ${file} cleaned - Size before: ${beforeSize} bytes, Size after: ${afterStats.size} bytes`);
                    filesProcessed++;
                } else {
                    logger.info(`File ${file} skipped - Not old enough`);
                }
            }
        }

        logger.info(`Log cleaning completed. Processed ${filesProcessed} files`);
    } catch (error) {
        logger.error(`Error cleaning logs: ${error.stack}`);
    }
};

module.exports = { logger, cleanLogs };
