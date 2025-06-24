#!/bin/bash

# Script para arreglar el PATH de Node.js para el usuario ubuntu
# Ejecutar esto como usuario ubuntu (NO como root)

echo "🔧 Arreglando PATH de Node.js para el usuario ubuntu..."

# Verificar si estamos como root
if [ "$EUID" -eq 0 ]; then 
   echo "❌ Por favor ejecuta este script como usuario ubuntu, NO como root"
   echo "Sal de root con 'exit' y luego ejecuta: bash fix-nodejs-path.sh"
   exit 1
fi

# Buscar dónde está instalado node
NODE_PATH=$(sudo which node)
NPM_PATH=$(sudo which npm)

echo "📍 Node encontrado en: $NODE_PATH"
echo "📍 NPM encontrado en: $NPM_PATH"

# Agregar las rutas al .bashrc del usuario
if [ -n "$NODE_PATH" ]; then
    NODE_DIR=$(dirname "$NODE_PATH")
    echo "📝 Agregando $NODE_DIR al PATH en .bashrc"
    
    # Verificar si ya está en .bashrc
    if ! grep -q "export PATH=\"$NODE_DIR:\$PATH\"" ~/.bashrc; then
        echo "" >> ~/.bashrc
        echo "# Node.js PATH" >> ~/.bashrc
        echo "export PATH=\"$NODE_DIR:\$PATH\"" >> ~/.bashrc
        echo "✅ PATH actualizado en .bashrc"
    else
        echo "ℹ️  PATH ya estaba configurado en .bashrc"
    fi
    
    # También agregar a .profile para sesiones no interactivas
    if ! grep -q "export PATH=\"$NODE_DIR:\$PATH\"" ~/.profile; then
        echo "" >> ~/.profile
        echo "# Node.js PATH" >> ~/.profile
        echo "export PATH=\"$NODE_DIR:\$PATH\"" >> ~/.profile
        echo "✅ PATH actualizado en .profile"
    else
        echo "ℹ️  PATH ya estaba configurado en .profile"
    fi
fi

# Crear enlaces simbólicos como alternativa
echo "📝 Creando enlaces simbólicos en /usr/local/bin..."
sudo ln -sf "$NODE_PATH" /usr/local/bin/node 2>/dev/null
sudo ln -sf "$NPM_PATH" /usr/local/bin/npm 2>/dev/null

# Recargar el perfil
echo "🔄 Recargando configuración..."
source ~/.bashrc

# Verificar
echo ""
echo "✅ Verificando instalación:"
echo "Node version: $(node --version 2>&1 || echo 'No encontrado')"
echo "NPM version: $(npm --version 2>&1 || echo 'No encontrado')"

echo ""
echo "📌 IMPORTANTE: Cierra y vuelve a abrir tu sesión SSH para que los cambios surtan efecto"
echo "   O ejecuta: source ~/.bashrc"