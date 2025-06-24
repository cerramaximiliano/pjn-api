#!/bin/bash

# Script para verificar la configuración del servidor EC2
# Ejecutar esto en el servidor para diagnosticar problemas

echo "🔍 Verificando configuración del servidor..."
echo ""

echo "📍 Información del sistema:"
uname -a
echo ""

echo "📍 Usuario actual:"
whoami
echo ""

echo "📍 PATH actual:"
echo $PATH
echo ""

echo "📍 Buscando Node.js:"
echo "which node: $(which node 2>&1)"
echo "which nodejs: $(which nodejs 2>&1)"
find /usr -name node -type f 2>/dev/null | head -5
echo ""

echo "📍 Buscando npm:"
echo "which npm: $(which npm 2>&1)"
find /usr -name npm -type f 2>/dev/null | head -5
echo ""

echo "📍 Buscando PM2:"
echo "which pm2: $(which pm2 2>&1)"
echo "sudo which pm2: $(sudo which pm2 2>&1)"
find /usr -name pm2 -type f 2>/dev/null | head -5
echo ""

echo "📍 Versiones (si están instaladas):"
node --version 2>&1 || echo "Node no encontrado"
npm --version 2>&1 || echo "NPM no encontrado"
pm2 --version 2>&1 || sudo pm2 --version 2>&1 || echo "PM2 no encontrado"
echo ""

echo "📍 Contenido de .bashrc (últimas líneas):"
tail -10 ~/.bashrc 2>/dev/null || echo ".bashrc no encontrado"
echo ""

echo "📍 Contenido de .profile (últimas líneas):"
tail -10 ~/.profile 2>/dev/null || echo ".profile no encontrado"
echo ""

echo "📍 Procesos PM2 actuales:"
pm2 list 2>&1 || sudo pm2 list 2>&1 || echo "No se pueden listar procesos PM2"