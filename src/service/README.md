# Servicios de Causas Judiciales

Este directorio contiene los servicios relacionados con la gestión de causas judiciales del Poder Judicial Nacional (PJN).

## Servicio Principal: `causasService.js`

El servicio `causasService.js` proporciona funcionalidades para gestionar operaciones relacionadas con documentos de causas judiciales. A continuación se detallan las funciones disponibles y sus rutas correspondientes:

### Métodos del Servicio

| Método | Descripción | Ruta API |
|--------|-------------|----------|
| `updateCausasUpdateStatus` | Actualiza el estado de actualización para un usuario específico | `PATCH /causas-service/update-status` |
| `updateCausasBasedOnSubscriptions` | Actualiza el estado de actualización considerando usuarios con suscripciones activas | `PATCH /causas-service/update-by-subscriptions` |
| `initializeUserUpdatesEnabled` | Inicializa el array userUpdatesEnabled para todas las causas | `POST /causas-service/initialize-updates` |
| `associateFolderToCausa` | Asocia un folder a un documento de causa | `POST /causas-service/associate-folder` |
| `dissociateFolderFromCausa` | Desasocia un folder de un documento de causa | `DELETE /causas-service/dissociate-folder` |
| `findCausaByFolderId` | Busca una causa que contenga un folder específico | `GET /causas-service/find-by-folder/:causaType/:folderId` |
| `getCausaTypeByPjnCode` | Determina qué tipo de causa corresponde según el código PJN | `GET /causas-service/causa-type-by-code/:pjnCode` |
| `migrateArrayFields` | Migra documentos para asegurar que folderIds y userCausaIds sean arrays | `POST /causas-service/migrate-array-fields/:causaType` |

## Tipos de Causa

El sistema maneja tres tipos de causas judiciales:

1. **CausasCivil** - Fuero Civil (código PJN: 1)
2. **CausasTrabajo** - Fuero Laboral (código PJN: 7)
3. **CausasSegSocial** - Fuero de Seguridad Social (código PJN: 5)

## Autenticación

Todos los endpoints, excepto la consulta de tipo de causa por código, requieren autenticación mediante token JWT. Algunos endpoints además requieren permisos de administrador.

## Uso de userUpdatesEnabled

El array `userUpdatesEnabled` se utiliza para rastrear qué usuarios tienen habilitada la actualización para cada causa. Esto permite un control granular para determinar si una causa debe actualizarse en función de las preferencias de los usuarios y sus suscripciones.

Ejemplo de estructura:
```json
userUpdatesEnabled: [
  {
    userId: "60a2b5e3c9e1c82a58e42f1e",
    enabled: true
  },
  {
    userId: "60a2b5e3c9e1c82a58e42f1f",
    enabled: false
  }
]
```

## API de Servicio de Causas

La API completa está documentada usando Swagger y se puede acceder a través de:

```
GET /api-docs
```

## Migración de Datos

Para facilitar la migración de datos existentes, se proporcionan herramientas como `initializeUserUpdatesEnabled` y `migrateArrayFields` que permiten actualizar la estructura de documentos cuando se agregan nuevos campos o se cambia el formato de los datos.