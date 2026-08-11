# Servicios de Causas Judiciales

Este directorio contiene los servicios relacionados con la gestión de causas judiciales del Poder Judicial Nacional (PJN).

## Servicio Principal: `causasService.js`

El servicio `causasService.js` proporciona funcionalidades para gestionar operaciones relacionadas con documentos de causas judiciales. A continuación se detallan las funciones disponibles y sus rutas correspondientes:

### Métodos del Servicio

| Método | Descripción | Ruta API |
|--------|-------------|----------|
| `updateCausasUpdateStatus` | Actualiza el estado de actualización para un usuario específico | `PATCH /causas-service/update-status` |
| `associateFolderToCausa` | Asocia un folder a un documento de causa | `POST /causas-service/associate-folder` |
| `dissociateFolderFromCausa` | Desasocia un folder de un documento de causa | `DELETE /causas-service/dissociate-folder` |
| `getCausaTypeByPjnCode` | Determina qué tipo de causa corresponde según el código PJN | `GET /causas-service/causa-type-by-code/:pjnCode` |

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

