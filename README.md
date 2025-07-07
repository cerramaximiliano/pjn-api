# API del Poder Judicial de la Nación (PJN)

API RESTful para acceder y gestionar datos judiciales del Poder Judicial de la Nación Argentina.

## 📋 Tabla de contenidos

- [Descripción](#descripción)
- [Instalación](#instalación)
- [Configuración](#configuración)
- [Uso](#uso)
- [Endpoints](#endpoints)
- [Modelos](#modelos)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Seguridad](#seguridad)
- [Tecnologías](#tecnologías)
- [Licencia](#licencia)

## 📝 Descripción

Esta API proporciona acceso a datos de causas judiciales de diferentes fueros del Poder Judicial de la Nación Argentina. Permite consultar, buscar y gestionar causas judiciales de los fueros Civil (CIV), Seguridad Social (CSS) y Trabajo (CNT).

## 🚀 Instalación

1. Clonar el repositorio:
   ```bash
   git clone <repositorio>
   cd pjn-api
   ```

2. Instalar dependencias:
   ```bash
   npm install
   ```

## ⚙️ Configuración

La aplicación utiliza variables de entorno para su configuración. Estas se cargan desde AWS Secrets Manager pero también pueden configurarse localmente:

```bash
# Crear archivo .env local
touch .env
```

Variables de entorno requeridas:
```env
PORT=8083
URLDB=mongodb://localhost:27017/pjn
SEED=tu_seed_jwt
JWT_SECRET=tu_secreto_jwt
API_KEY=tu_api_key_segura
# Configuración AWS SES (opcional)
AWS_SES_USER=tu_usuario_ses
AWS_SES_PASS=tu_password_ses
```

## 🏁 Uso

Para iniciar el servidor:

```bash
# Desarrollo
npm run dev

# Producción
npm start
# o
node src/server.js
```

La API estará disponible en `http://localhost:8083/api`

## 🌐 Endpoints

### Test de conexión
- **GET** `/api/causas/test`
  - Verifica que el router de causas esté funcionando
  - Respuesta: `{ message: 'Router de causas funcionando' }`

### Causas judiciales

Todos los endpoints de causas utilizan el parámetro `fuero` que puede ser:
- `CIV`: Fuero Civil
- `CSS`: Fuero de Seguridad Social
- `CNT`: Fuero del Trabajo

#### Búsqueda con filtros (API Key)
- **GET** `/api/causas/:fuero/filtros`
  - Busca causas aplicando múltiples filtros
  - **Autenticación**: Requiere API Key
  - **Parámetros de ruta**:
    - `fuero`: Tipo de fuero judicial (CIV, CNT, CSS)
  - **Parámetros de query** (todos opcionales):
    - `verified`: Boolean - Filtra causas verificadas (true/false)
    - `isValid`: Boolean - Filtra causas válidas (true/false)
    - `update`: Boolean - Filtra causas marcadas para actualización (true/false)
    - `source`: String - Filtra por origen de los datos (ej: "scraping", "manual")
  - **Autenticación API Key** (usar una de estas formas):
    - Header: `x-api-key: tu_api_key` o `api-key: tu_api_key`
    - Query: `?apiKey=tu_api_key`
    - Body: `{ "apiKey": "tu_api_key" }`
  - **Respuesta**: 
    ```json
    {
      "success": true,
      "message": "Se encontraron X causas en FUERO. Filtros aplicados: ...",
      "count": 25,
      "filters": {
        "fuero": "CIV",
        "verified": true,
        "isValid": true,
        "update": false,
        "source": "scraping"
      },
      "limitApplied": false,
      "data": [
        {
          "fuero": "CIV",
          "number": 12345,
          "year": 2024
        }
      ]
    }
    ```
  - **Límites**: Máximo 100 resultados por consulta
  - **Ejemplos**:
    ```bash
    # Con header
    curl -H "x-api-key: tu_api_key" \
      "http://localhost:8083/api/causas/CIV/filtros?verified=true&isValid=true"
    
    # Con query parameter
    curl "http://localhost:8083/api/causas/CNT/filtros?apiKey=tu_api_key&update=true"
    ```

#### Causas verificadas (JWT)
- **GET** `/api/causas/verified`
  - Obtiene todas las causas verificadas de los tres fueros
  - **Autenticación**: Requiere token JWT
  - **Respuesta**: Array con causas de todos los fueros que están verificadas y válidas

#### Consulta por número y año (JWT)
- **GET** `/api/causas/:fuero/:number/:year`
  - Busca una causa específica por su número y año
  - **Autenticación**: Requiere token JWT
  - **Parámetros de ruta**:
    - `fuero`: Fuero judicial (CIV, CSS, CNT)
    - `number`: Número de causa
    - `year`: Año de la causa
  - **Respuesta**: Objeto con los datos de la causa o error 404 si no existe

#### Listado de objetos judiciales (JWT)
- **GET** `/api/causas/:fuero/objetos`
  - Obtiene la lista de objetos judiciales únicos disponibles para un fuero
  - **Autenticación**: Requiere token JWT
  - **Parámetros de ruta**:
    - `fuero`: Fuero judicial (CIV, CSS, CNT)
  - **Respuesta**: Array de strings con los nombres de objetos judiciales

#### Búsqueda por objeto judicial (JWT)
- **GET** `/api/causas/:fuero/buscar/objeto`
  - Busca causas por tipo de objeto judicial
  - **Autenticación**: Requiere token JWT
  - **Parámetros de ruta**:
    - `fuero`: Fuero judicial (CIV, CSS, CNT)
  - **Parámetros de consulta**:
    - `objeto`: Texto del objeto judicial a buscar (parcial o completo)
  - **Respuesta**: Array de causas que coinciden con el objeto

#### Búsqueda avanzada (JWT)
- **GET** `/api/causas/:fuero/buscar`
  - Realiza una búsqueda avanzada de causas con múltiples criterios
  - **Autenticación**: Requiere token JWT
  - **Parámetros de ruta**:
    - `fuero`: Fuero judicial (CIV, CSS, CNT)
  - **Parámetros de consulta**:
    - `year`: Año de la causa (opcional)
    - `caratula`: Texto en la carátula (opcional)
    - `juzgado`: Juzgado asignado (opcional)
    - `objeto`: Objeto de la causa (opcional)
  - **Respuesta**: Array de causas que cumplen con los criterios (máximo 100 resultados)

#### Movimientos de una causa (JWT)
- **GET** `/api/causas/:fuero/:id/movimientos`
  - Obtiene los movimientos de una causa específica con paginación
  - **Autenticación**: Requiere token JWT
  - **Parámetros de ruta**:
    - `fuero`: Fuero judicial (CIV, CSS, CNT)
    - `id`: ID de la causa
  - **Parámetros de query**:
    - `page`: Número de página (default: 1)
    - `limit`: Movimientos por página (default: 20)
  - **Respuesta**: Movimientos paginados con información de la causa

#### Agregar causa (JWT + Admin)
- **POST** `/api/causas/:fuero/agregar`
  - Agrega una nueva causa o asocia un usuario a una causa existente
  - **Autenticación**: Requiere token JWT y rol de administrador
  - **Parámetros de ruta**:
    - `fuero`: Fuero judicial (CIV, CSS, CNT)
  - **Cuerpo de la solicitud** (JSON):
    - `number`: Número de causa (requerido)
    - `year`: Año de la causa (requerido)
    - `userId`: ID del usuario para asociar (opcional)
    - Otros datos de la causa (opcionales)
  - **Respuesta**: 
    - Si la causa existe y se proporciona userId: Asocia el usuario
    - Si la causa existe y no se proporciona userId: Devuelve los datos de la causa
    - Si la causa no existe: Crea una nueva causa

#### Eliminar causa (JWT + Admin)
- **DELETE** `/api/causas/:fuero/:id`
  - Elimina una causa por su ID
  - **Autenticación**: Requiere token JWT y rol de administrador
  - **Parámetros de ruta**:
    - `fuero`: Fuero judicial (CIV, CSS, CNT)
    - `id`: ID de la causa a eliminar
  - **Respuesta**: Confirmación de eliminación con datos básicos de la causa eliminada

### Códigos de Estado HTTP

- **200 OK**: Operación exitosa
- **400 Bad Request**: Parámetros inválidos o faltantes
- **401 Unauthorized**: Token JWT o API Key no proporcionada o inválida
- **403 Forbidden**: Sin permisos suficientes (requiere rol admin)
- **404 Not Found**: Recurso no encontrado
- **500 Internal Server Error**: Error del servidor

## 📊 Modelos

La API utiliza el paquete `pjn-models` que proporciona los siguientes modelos:

- **CausasCivil**: Causas del fuero civil
- **CausasSegSoc**: Causas del fuero de seguridad social
- **CausasTrabajo**: Causas del fuero laboral

### Estructura de los modelos:
- `number`: Número de causa
- `year`: Año de la causa
- `fuero`: Fuero judicial (CIV, CSS, CNT)
- `caratula`: Nombre de la causa
- `objeto`: Objeto judicial
- `juzgado`: Juzgado asignado
- `secretaria`: Secretaría
- `movimiento`: Array de movimientos
- `movimientosCount`: Contador de movimientos
- `fechaUltimoMovimiento`: Fecha del último movimiento
- `userCausaIds`: Array de IDs de usuarios asociados
- `folderIds`: Array de IDs de carpetas
- `source`: Origen de los datos (default: "scraping")
- `verified`: Boolean - Si está verificada (default: false)
- `isValid`: Boolean - Si es válida (default: null)
- `update`: Boolean - Si necesita actualización (default: false)
- `userUpdatesEnabled`: Array de configuraciones de actualización por usuario
- `date`: Fecha de creación
- `lastUpdate`: Última actualización

## 📁 Estructura del proyecto

```
/pjn-api
├── README.md
├── ecosystem.config.js
├── package.json
├── .env                    # Variables de entorno (no incluir en git)
├── src/
│   ├── config/
│   │   ├── aws.js         # Configuración AWS
│   │   ├── env.js         # Carga de variables de entorno
│   │   └── pino.js        # Configuración del logger
│   ├── controllers/
│   │   ├── aws-ses.js     # Controlador para envío de emails
│   │   └── causasController.js  # Controlador principal de causas
│   ├── logs/              # Directorio de logs
│   ├── middleware/
│   │   └── auth.js        # Middlewares de autenticación (JWT y API Key)
│   ├── models/            # Modelos locales (si los hay)
│   ├── routes/
│   │   ├── causasRoutes.js    # Rutas de causas
│   │   └── index.js           # Rutas principales
│   ├── service/           # Lógica de negocio
│   │   └── causasService.js   # Servicios de causas
│   ├── server.js          # Punto de entrada de la aplicación
│   └── utils/             # Utilidades
```

## 🔒 Seguridad

- **Autenticación dual**: JWT para usuarios y API Key para acceso programático
- **Roles y permisos**: Sistema de roles para operaciones sensibles (admin)
- **API Key**: 
  - Debe mantenerse segura y no compartirse públicamente
  - Se recomienda rotar periódicamente
  - No incluir en código fuente o repositorios públicos
- **Logs**: Todos los intentos de acceso se registran
- **HTTPS**: Usar HTTPS en producción
- **Rate limiting**: Implementar límites de tasa en producción
- **CORS**: Configurado según necesidades del cliente

## 📧 Envío de correos

La API incluye funcionalidad para enviar correos electrónicos mediante AWS SES:

```javascript
const { sendEmailController } = require('./controllers/aws-ses');

// Ejemplo de uso
const result = await sendEmailController(
  'destinatario@ejemplo.com',
  'Contenido del correo',
  'Asunto del correo',
  []  // Archivos adjuntos (opcional)
);
```

## 🛠️ Tecnologías

- **Node.js**: Entorno de ejecución
- **Express.js**: Framework web
- **MongoDB**: Base de datos
- **Mongoose**: ODM para MongoDB
- **JWT**: Autenticación basada en tokens
- **Pino**: Logger de alta performance
- **AWS SDK**: Integración con servicios AWS
- **AWS SES**: Servicio de envío de emails
- **PM2**: Gestor de procesos (producción)

## 📄 Licencia

Este proyecto está bajo la Licencia ISC.