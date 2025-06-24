#!/bin/bash

# Script de configuración inicial para EC2
# Ejecutar esto una sola vez en el servidor EC2

set -e

echo "🚀 Configurando servidor EC2 para pjn-api..."

# Actualizar sistema
echo "📦 Actualizando paquetes del sistema..."
sudo apt-get update

# Instalar Node.js 18 usando NodeSource
echo "📦 Instalando Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verificar instalación
echo "✅ Node.js version: $(node --version)"
echo "✅ NPM version: $(npm --version)"

# Instalar PM2 globalmente
echo "📦 Instalando PM2..."
sudo npm install -g pm2

# Configurar PM2 para iniciar al arrancar
echo "⚙️ Configurando PM2 startup..."
sudo pm2 startup systemd -u $USER --hp $HOME
# Nota: Ejecuta el comando que PM2 te sugiera después de este script

# Crear directorio para la aplicación
echo "📁 Creando directorio de la aplicación..."
mkdir -p ~/pjn-api

echo "✅ Configuración completada!"
echo ""
echo "⚠️  IMPORTANTE: Ejecuta el comando que PM2 sugirió arriba para configurar el startup"
echo ""
echo "📝 Próximos pasos:"
echo "1. Configura las variables de entorno necesarias"
echo "2. Asegúrate de que MongoDB sea accesible desde este servidor"
echo "3. Abre el puerto 8083 en el Security Group de AWS"
echo "4. El deployment automático ya está listo para usar"