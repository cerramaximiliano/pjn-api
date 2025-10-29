# Migración de Códigos de Fuero

## Problema Identificado

Los documentos de causas se estaban guardando con nombres descriptivos del fuero en lugar de los códigos estandarizados:

- ❌ **Antes**: `"Seguridad Social"`, `"Civil"`, `"Laboral"`, `"Comercial"`
- ✅ **Ahora**: `"CSS"`, `"CIV"`, `"CNT"`, `"COM"`

## Cambios Realizados

### 1. Normalización en Endpoints (`src/routes/causasServiceRoutes.js`)

Se agregó una función `normalizeCausaType()` que acepta múltiples formatos de entrada y los convierte al nombre de modelo correcto:

**Formatos aceptados:**
- Nombres descriptivos: `"Civil"`, `"Comercial"`, `"Seguridad Social"`, `"Laboral"`, `"Trabajo"`
- Códigos de fuero: `"CIV"`, `"COM"`, `"CSS"`, `"CNT"`
- Nombres de modelo: `"CausasCivil"`, `"CausasComercial"`, `"CausasSegSocial"`, `"CausasTrabajo"`

**Mapeo de códigos:**
```javascript
'CIV' → CausasCivil  (modelo) → fuero: "CIV" (guardado en BD)
'COM' → CausasComercial       → fuero: "COM"
'CSS' → CausasSegSocial       → fuero: "CSS"
'CNT' → CausasTrabajo         → fuero: "CNT"
```

### 2. Endpoints Actualizados

Los siguientes endpoints ahora normalizan automáticamente el `causaType`:

- ✅ `POST /causas-service/associate-folder`
- ✅ `DELETE /causas-service/dissociate-folder`
- ✅ `GET /causas-service/find-by-folder/:causaType/:folderId`

### 3. Endpoint de Migración

Se creó un nuevo endpoint administrativo para corregir datos existentes:

**Endpoint:** `POST /causas-service/migrate-fuero-codes`

**Autenticación:** Requiere token JWT y rol de administrador

**Respuesta:**
```json
{
  "success": true,
  "message": "Migración completada. Total de documentos actualizados: X",
  "updated": {
    "civil": 0,
    "comercial": 0,
    "segSocial": 15,
    "trabajo": 3
  },
  "total": 18
}
```

## Instrucciones de Migración

### Paso 1: Ejecutar la migración

```bash
curl -X POST https://tu-api.com/api/causas-service/migrate-fuero-codes \
  -H "Authorization: Bearer TU_TOKEN_ADMIN" \
  -H "Content-Type: application/json"
```

### Paso 2: Verificar los resultados

Revisar la respuesta para confirmar cuántos documentos fueron actualizados en cada colección.

### Paso 3: Validar en la base de datos

Ejecutar queries en MongoDB para verificar:

```javascript
// No debe devolver documentos con valores incorrectos
db.getCollection('causas-civil').find({fuero: {$ne: 'CIV'}})
db.getCollection('causas-comercial').find({fuero: {$ne: 'COM'}})
db.getCollection('causas-ss').find({fuero: {$ne: 'CSS'}})
db.getCollection('causas-trabajo').find({fuero: {$ne: 'CNT'}})
```

## Valores que se Migrarán

### CausasCivil → CIV
- `"Civil"`, `"civil"`, `"CIVIL"`

### CausasComercial → COM
- `"Comercial"`, `"comercial"`, `"COMERCIAL"`

### CausasSegSocial → CSS
- `"Seguridad Social"`, `"seguridad social"`, `"SEGURIDAD SOCIAL"`, `"SS"`, `"ss"`

### CausasTrabajo → CNT
- `"Laboral"`, `"laboral"`, `"LABORAL"`
- `"Trabajo"`, `"trabajo"`, `"TRABAJO"`

## Compatibilidad con Aplicaciones Cliente

Las aplicaciones cliente pueden seguir enviando cualquiera de los formatos aceptados. El servidor automáticamente los normalizará al código correcto antes de guardar en la base de datos.

**Ejemplo:**
```javascript
// La app puede enviar:
{
  "causaType": "Seguridad Social",  // o "CSS" o "CausasSegSocial"
  "number": "65441",
  "year": "2016",
  // ...
}

// Se guardará en BD como:
{
  "fuero": "CSS",  // ✓ Siempre el código correcto
  // ...
}
```

## Notas Importantes

1. **Backwards Compatible**: Los cambios son compatibles con versiones anteriores. Las apps no necesitan actualizarse inmediatamente.

2. **Idempotente**: La migración puede ejecutarse múltiples veces sin problemas. Solo actualiza documentos que aún tienen valores incorrectos.

3. **Performance**: La migración utiliza `updateMany()` para actualizar múltiples documentos eficientemente.

4. **Logs**: El endpoint registra en consola el progreso de la migración para cada colección.

## Fecha de Implementación

**Fecha**: 2025-10-28
**Versión**: 1.0.0
