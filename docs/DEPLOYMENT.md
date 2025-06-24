# Guía de Deployment CI/CD

## Configuración de GitHub Actions para AWS EC2

Esta guía describe cómo configurar el pipeline de CI/CD para desplegar automáticamente en AWS EC2.

## Requisitos Previos

1. Acceso SSH a tu instancia EC2
2. PM2 instalado en el servidor EC2
3. Node.js 18+ instalado en el servidor EC2
4. Repositorio en GitHub

## Configuración de Secrets en GitHub

Ve a tu repositorio en GitHub → Settings → Secrets and variables → Actions → New repository secret

Agrega los siguientes secrets:

### 1. EC2_HOST
- **Descripción**: IP pública o dominio de tu instancia EC2
- **Ejemplo**: `54.123.456.789` o `mi-servidor.com`

### 2. EC2_USERNAME
- **Descripción**: Usuario SSH para conectarse a EC2
- **Ejemplo**: `ubuntu`, `ec2-user`, o el usuario que uses

### 3. EC2_SSH_KEY
- **Descripción**: Clave privada SSH completa para conectarse a EC2
- **Cómo obtenerla**:
  ```bash
  cat ~/.ssh/tu-clave-ec2.pem
  ```
- **Importante**: Copia TODO el contenido, incluyendo las líneas `-----BEGIN RSA PRIVATE KEY-----` y `-----END RSA PRIVATE KEY-----`

### 4. EC2_SSH_PORT (Opcional)
- **Descripción**: Puerto SSH si no es el estándar 22
- **Default**: 22

### 5. APP_PORT (Opcional)
- **Descripción**: Puerto donde corre tu aplicación
- **Default**: 8083

## Preparación del Servidor EC2

### Opción 1: Script Automático (Recomendado)

Copia y ejecuta el script de configuración en tu servidor EC2:

```bash
# Descargar y ejecutar el script de setup
curl -o setup-ec2.sh https://raw.githubusercontent.com/tu-usuario/pjn-api/main/scripts/setup-ec2.sh
chmod +x setup-ec2.sh
./setup-ec2.sh
```

### Opción 2: Instalación Manual

1. **Instalar Node.js y PM2**:
   ```bash
   # Instalar Node.js 18
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   
   # Instalar PM2 globalmente
   sudo npm install -g pm2
   
   # Configurar PM2 para iniciar al arrancar el sistema
   pm2 startup systemd
   # Sigue las instrucciones que te da el comando anterior
   ```

2. **Crear directorio para la aplicación**:
   ```bash
   mkdir -p ~/pjn-api
   ```

3. **Configurar variables de entorno**:
   - Las variables de entorno se manejan a través del servicio de AWS Secrets Manager
   - Asegúrate de que la instancia EC2 tenga los permisos IAM necesarios

### Verificar la instalación

```bash
# Verificar versiones
node --version  # Debe mostrar v18.x.x
npm --version   # Debe mostrar 9.x.x o superior
pm2 --version   # Debe mostrar la versión de PM2
```

## Flujo de Deployment

1. **Push a main**: Cualquier push a la rama `main` activa el deployment automático
2. **Manual**: Ve a Actions → Deploy to EC2 → Run workflow

El pipeline:
1. Hace checkout del código
2. Instala dependencias de producción
3. Sincroniza archivos con EC2 (excluyendo node_modules, .env, etc.)
4. Instala dependencias en el servidor
5. Recarga la aplicación con PM2
6. Realiza un health check

## Monitoreo

### Ver logs en EC2:
```bash
# Logs de PM2 (usar sudo si es necesario)
pm2 logs "pjn/api"
# o
sudo pm2 logs "pjn/api"

# Status de la aplicación
pm2 status
# o
sudo pm2 status

# Monitoreo en tiempo real
pm2 monit
# o
sudo pm2 monit
```

### Ver logs de GitHub Actions:
- Ve a la pestaña Actions en tu repositorio
- Click en el workflow run para ver detalles

## Troubleshooting

### La aplicación no responde después del deployment
1. Verifica los logs de PM2: `pm2 logs "pjn/api"` o `sudo pm2 logs "pjn/api"`
2. Verifica que MongoDB esté accesible desde EC2
3. Verifica las variables de entorno

### Error de permisos SSH
1. Verifica que la clave SSH sea correcta
2. Verifica que el usuario tenga permisos en el directorio de la aplicación
3. Asegúrate de que los permisos del archivo .pem sean 600

### Health check falla
1. Verifica que el puerto esté abierto en el Security Group de EC2
2. Verifica que la aplicación esté corriendo: `pm2 status` o `sudo pm2 status`
3. Prueba manualmente: `curl http://localhost:8083/api/causas/test`

### PM2 no encontrado o requiere sudo
Si PM2 fue instalado con sudo, todos los comandos PM2 necesitan sudo:
```bash
sudo pm2 status
sudo pm2 logs
sudo pm2 reload ecosystem.config.js --env production
```

El workflow de GitHub Actions detecta automáticamente si PM2 necesita sudo.

## Rollback

Si necesitas hacer rollback:
```bash
# En el servidor EC2
cd ~/pjn-api
git log --oneline -5  # Ver últimos commits
git checkout <commit-anterior>
npm ci --production
pm2 reload ecosystem.config.js --env production
# o si PM2 requiere sudo:
# sudo pm2 reload ecosystem.config.js --env production
```