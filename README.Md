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

# Editar archivo y agregar variables
PORT=8083
URLDB=mongodb://localhost:27017/pjn
```

Variables de entorno requeridas:
- `PORT`: Puerto en el que se ejecutará el servidor (por defecto: 8083)
- `URLDB`: URL de conexión a MongoDB

## 🏁 Uso

Para iniciar el servidor:

```bash
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

#### Consulta por número y año
- **GET** `/api/causas/:fuero/:number/:year`
  - Busca una causa específica por su número y año
  - Parámetros de ruta:
    - `fuero`: Fuero judicial (CIV, CSS, CNT)
    - `number`: Número de causa
    - `year`: Año de la causa
  - Respuesta: Objeto con los datos de la causa o error 404 si no existe

#### Listado de objetos judiciales
- **GET** `/api/causas/:fuero/objetos`
  - Obtiene la lista de objetos judiciales disponibles para un fuero
  - Parámetros de ruta:
    - `fuero`: Fuero judicial (CIV, CSS, CNT)
  - Respuesta: Array de strings con los nombres de objetos judiciales

#### Búsqueda por objeto judicial
- **GET** `/api/causas/:fuero/buscar/objeto`
  - Busca causas por tipo de objeto judicial
  - Parámetros de ruta:
    - `fuero`: Fuero judicial (CIV, CSS, CNT)
  - Parámetros de consulta:
    - `objeto`: Texto del objeto judicial a buscar (parcial o completo)
  - Respuesta: Array de causas que coinciden con el objeto

#### Búsqueda avanzada
- **GET** `/api/causas/:fuero/buscar`
  - Realiza una búsqueda avanzada de causas con múltiples criterios
  - Parámetros de ruta:
    - `fuero`: Fuero judicial (CIV, CSS, CNT)
  - Parámetros de consulta:
    - `year`: Año de la causa (opcional)
    - `caratula`: Texto en la carátula (opcional)
    - `juzgado`: Juzgado asignado (opcional)
    - `objeto`: Objeto de la causa (opcional)
  - Respuesta: Array de causas que cumplen con los criterios (máximo 100 resultados)

#### Agregar causa
- **POST** `/api/causas/:fuero/agregar`
  - Agrega una nueva causa o asocia un usuario a una causa existente
  - Parámetros de ruta:
    - `fuero`: Fuero judicial (CIV, CSS, CNT)
  - Cuerpo de la solicitud (JSON):
    - `number`: Número de causa (requerido)
    - `year`: Año de la causa (requerido)
    - `userId`: ID del usuario para asociar (opcional)
    - Otros datos de la causa (opcionales)
  - Respuesta: 
    - Si la causa existe y se proporciona userId: Asocia el usuario
    - Si la causa existe y no se proporciona userId: Devuelve los datos de la causa
    - Si la causa no existe: Crea una nueva causa

## 📊 Modelos

La API utiliza el paquete `pjn-models` que proporciona los siguientes modelos:

- **CausasCivil**: Causas del fuero civil
- **CausasSegSoc**: Causas del fuero de seguridad social
- **CausasTrabajo**: Causas del fuero laboral

Los modelos contienen campos como:
- `number`: Número de causa
- `year`: Año de la causa
- `fuero`: Fuero judicial (CIV, CSS, CNT)
- `caratula`: Nombre de la causa
- `objeto`: Objeto judicial
- `juzgado`: Juzgado asignado
- `userCausaIds`: Array de IDs de usuarios asociados
- `date`: Fecha de creación

## 📁 Estructura del proyecto

```
/pjn-api
├── README.md
├── ecosystem.config.js
├── package.json
├── src/
│   ├── config/
│   │   ├── aws.js
│   │   ├── env.js
│   │   └── pino.js
│   ├── controllers/
│   │   ├── aws-ses.js
│   │   └── causasController.js
│   ├── logs/
│   ├── models/
│   │   ├── causas-civil.js
│   │   ├── causas-ss.js
│   │   └── causas-trabajo.js
│   ├── routes/
│   │   ├── causasRoutes.js
│   │   └── index.js
│   ├── server.js
│   └── utils/
```

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

## 📄 Licencia

Este proyecto está bajo la Licencia ISC.