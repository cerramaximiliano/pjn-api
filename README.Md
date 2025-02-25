# PJN Web Scraping API

Este proyecto proporciona una API y un sistema de workers para recopilar y procesar datos del **Portal de Consultas de Causas Judiciales de Argentina (PJN)**.

## Estructura del Proyecto

Este proyecto está dividido en dos componentes principales:

- **API**: Servidor que proporciona endpoints para consultar la información recopilada.
- **Workers**: Sistema de scraping automatizado que recolecta y procesa los datos.

## Estructura para la API

```plaintext
/pjn-api/
├── src/
│   ├── controllers/       # Tus controladores existentes
│   │   ├── aws-ses.js     # Controlador para AWS SES
│   │   ├── auth.js        # Controlador de autenticación
│   │   └── causas.js      # Controlador de causas
│   ├── routes/            # Tus rutas existentes
│   │   ├── auth.js        # Rutas de autenticación
│   │   ├── causas.js      # Rutas de causas
│   │   └── index.js       # Archivo principal de rutas
│   ├── middleware/        # Middleware de la API
│   │   ├── auth.js        # Middleware de autenticación
│   │   └── error.js       # Manejo de errores
│   ├── models/            # Tus modelos existentes
│   │   ├── causas-civil.js
│   │   ├── causas-ss.js
│   │   └── causas-trabajo.js
│   ├── config/            # Configuraciones
│   │   ├── pino.js        # Configuración de logging
│   │   ├── env.js         # Manejo de variables de entorno
│   │   └── database.js    # Configuración de MongoDB
│   ├── utils/             # Utilidades compartidas
│   │   ├── ddbb.js        # Monitoreo de base de datos
│   │   └── response.js    # Formateador de respuestas
│   └── server.js          # Punto de entrada de la API
├── .env.example           # Ejemplo de variables de entorno
├── .gitignore             # Archivo gitignore
├── package.json           # Dependencias y scripts
└── README.md              # Documentación
  ```

## Requisitos

- **Node.js** 16.x o superior
- **MongoDB**
- **AWS SES** (para notificaciones por email)
- **2Captcha** (para resolver captchas)

## Instalación

### Clonar el repositorio:

```bash
git clone https://github.com/username/pjn-api.git
cd pjn-api
```

### Instalar dependencias:

```bash
npm install
```

### Configurar variables de entorno:

- Crear un archivo `.env` siguiendo el ejemplo en `.env.example`.
- O configurar las variables en **AWS Secrets Manager**.

## Configuración

### Variables de Entorno

```ini
# MongoDB
URLDB=mongodb+srv://...

# AWS
AWS_SES_KEY_ID=your_key_id
AWS_SES_ACCESS_KEY=your_access_key
AWS_REGION=us-east-1

# 2Captcha
CAPTCHA_KEY=your_captcha_key

# Worker 
FUERO=CIV  # CIV, CSS, CNT

# API
PORT=3000
```

## Uso

### API

**Iniciar el servidor:**

```bash
npm run start:api
```

El servidor estará disponible en [http://localhost:3000](http://localhost:3000)

### Worker

**Iniciar el worker (por fuero):**

```bash
npm run start:worker
```

## Endpoints

- `GET /api/:fuero/:number/:year` - Obtener detalles de una causa específica por número y año
- `GET /api/:fuero/objetos` - Listar los objetos disponibles para un fuero
- `GET /api/:fuero/buscar/objeto` - Buscar causas por objeto
- `GET /api/:fuero/buscar` - Búsqueda avanzada de causas
- `POST /api/:fuero/agregar` - Agregar una nueva causa al sistema

Ejemplos:
- `/api/CIV/12345/2023` - Consulta la causa civil número 12345 del año 2023
- `/api/CSS/objetos` - Lista todos los objetos disponibles en el fuero de Seguridad Social
- `/api/CNT/buscar/objeto?q=despido` - Busca causas de trabajo relacionadas con despidos
- `/api/CIV/buscar?juzgado=5&secretaria=10` - Búsqueda avanzada de causas civiles por juzgado y secretaría

### Agregar una nueva causa

**Endpoint:** `POST /api/:fuero/agregar`

**Parámetros:**
- `fuero` (en URL): CIV, CSS o CNT

**Body:**
```json
{
  "number": "12345",
  "year": "2023",
  "userId": "60d5ec9af682727e1d2f5abc",  // Opcional
  "caratula": "Título de la causa",
  "juzgado": 5,
  "secretaria": 10,
  "objeto": "Descripción del objeto"
  // Otros campos específicos...
}

## Monitoreo

El sistema incluye monitoreo automático que:

- Verifica el estado del almacenamiento en **MongoDB**.
- Envía alertas por email si el espacio está cerca del límite.
- Mantiene registros detallados de la actividad.

## Desarrollo

### Scripts

```bash
npm run dev:api      # Ejecutar API en modo desarrollo
npm run dev:worker   # Ejecutar worker en modo desarrollo
npm run lint         # Verificar estilo de código
npm run test         # Ejecutar pruebas
```

## Contribuciones

1. Hacer **fork** del repositorio.
2. Crear una rama para tu funcionalidad:
   ```bash
   git checkout -b feature/nueva-funcionalidad
   ```
3. Hacer **commit** de tus cambios:
   ```bash
   git commit -m 'Agregar nueva funcionalidad'
   ```
4. Hacer **push** a la rama:
   ```bash
   git push origin feature/nueva-funcionalidad
   ```
5. Crear un **Pull Request**.

## Licencia

Este proyecto está bajo la **Licencia MIT** - ver el archivo `LICENSE` para más detalles.

## Agradecimientos

- **PJN** - Portal de consultas de causas judiciales.
- **MongoDB Atlas** - Base de datos en la nube.
- **2Captcha** - Servicio de resolución de captchas.