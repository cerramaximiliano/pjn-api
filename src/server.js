const express = require("express");
const app = express();
const dotenv = require("dotenv");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const retrieveSecrets = require("./config/env");
const mongoose = require("mongoose");
const indexRoutes = require("./routes/index");
const { logger } = require("./config/pino");
const fsPromises = require("fs").promises;
const morgan = require("morgan");


app.use(morgan("dev"));
app.use(cors());
app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static("public"));
app.use('/api', indexRoutes);

// Capturar rutas 404 - debe ir después de todas las demás rutas
app.use((req, res) => {
  res.status(404).json({ 
    status: 'error',
    message: 'Ruta no encontrada'
  });
});

async function initializeServer() {
    try {
        const secretsString = await retrieveSecrets();
        await fsPromises.writeFile(".env", secretsString);
        dotenv.config();

        const port = process.env.PORT || 8083;
        app.listen(port, async () => {
            logger.info(`Server listening on PORT ${port}`);

        });
        
        const URLDB = process.env.URLDB;
        await mongoose.connect(URLDB);
        logger.info("Conexión a MongoDB establecida");

    } catch (err) {
        logger.error(`Error initializing server: ${err}`);
        process.exit(1);
    }
}

initializeServer();

module.exports = app;