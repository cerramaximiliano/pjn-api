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


const allowedOrigins = {
  development: ["http://localhost:3000", "http://localhost:5000", "http://localhost:5174"],
  local: ["http://localhost:3000", "http://localhost:5000", "http://localhost:5174"],
  production: ["https://www.lawanalytics.app", "https://lawanalytics.app"]
};

const currentEnv = process.env.NODE_ENV || "development";

// Configuración de CORS
app.use(
  cors({
    origin: function (origin, callback) {
      // Permitir cualquier origen con soporte para credentials
      callback(null, origin);
    },
    credentials: true,
    methods: ["GET", "DELETE", "POST", "PUT", "OPTIONS", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning"]
  })
);

app.use(morgan("dev"));
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
    await fsPromises.writeFile(".env", secretsString, { mode: 0o600 });
    // `mode` solo aplica cuando writeFile CREA el archivo: si el .env ya existía
    // conserva sus permisos previos (644) y los ~120 secretos del ecosistema
    // quedan legibles por cualquier usuario del box. De ahí el chmod explícito.
    await fsPromises.chmod(".env", 0o600);
    dotenv.config();

    const port = process.env.PORT || 8083;
    app.listen(port, async () => {
      logger.info(`Server listening on PORT ${port}`);

    });

    // MONGO_TARGET=rs0 lo usa la instancia "cache" del hub (pjn/cache-api), que
    // sirve el caché de causas leyendo del secundario del replica set. La URI
    // sale del secreto de AWS como el resto: así la credencial no vive en el
    // dump de PM2 y una rotación se propaga sola al reiniciar.
    const URLDB = process.env.MONGO_TARGET === 'rs0'
      ? process.env.SENTENCIAS_MONGO_URI
      : process.env.NODE_ENV === 'local'
        ? process.env.URLDB_LOCAL
        : process.env.URLDB;
    if (!URLDB) throw new Error(`No hay URI de Mongo para MONGO_TARGET=${process.env.MONGO_TARGET} / NODE_ENV=${process.env.NODE_ENV}`);
    await mongoose.connect(URLDB);
    logger.info(`Conexión a MongoDB establecida en ambiente ${process.env.NODE_ENV}${process.env.MONGO_TARGET ? ` (target ${process.env.MONGO_TARGET})` : ''}`);

    // Inicializar caché HyDE (Redis, lazy-connect, solo si HYDE_ENABLED=true)
    const { initHydeCache } = require('./services/hydeCache');
    initHydeCache();

    // Collector de monitoreo de infraestructura: solo recolecta en la instancia local
    // (NODE_ENV=local, worker_01) que ve Qdrant + Mongo local; escribe snapshots a Atlas.
    const { startCollector } = require('./services/monitoringService');
    startCollector(logger);

  } catch (err) {
    logger.error(`Error initializing server: ${err}`);
    process.exit(1);
  }
}

initializeServer();

module.exports = app;