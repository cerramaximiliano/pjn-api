/**
 * Script para crear el documento de configuración del Manager
 * Ejecutar: node scripts/create-manager-config.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { ManagerConfig } = require('pjn-models');

const MONGO_URI = process.env.URLDB || process.env.MONGODB_URI || process.env.MONGO_URI;

async function createManagerConfig() {
    try {
        console.log('Conectando a MongoDB...');
        await mongoose.connect(MONGO_URI);
        console.log('Conectado a MongoDB');

        // Verificar si ya existe
        const existing = await ManagerConfig.findOne({ name: 'app-update-manager' });

        if (existing) {
            console.log('\n✓ El documento de configuración ya existe:');
            console.log(`  ID: ${existing._id}`);
            console.log(`  Creado: ${existing.createdAt}`);
            console.log(`  Última actualización: ${existing.lastUpdate}`);
            console.log('\nConfiguración actual:');
            console.log(JSON.stringify(existing.config, null, 2));
        } else {
            console.log('\nCreando nuevo documento de configuración...');
            const config = await ManagerConfig.getOrCreate();
            console.log('\n✓ Documento creado exitosamente:');
            console.log(`  ID: ${config._id}`);
            console.log('\nConfiguración por defecto:');
            console.log(JSON.stringify(config.config, null, 2));
        }

    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('\nDesconectado de MongoDB');
    }
}

createManagerConfig();
