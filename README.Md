# pjn-models

📦 **pjn-models** es un paquete de modelos de **Mongoose** reutilizable para múltiples proyectos relacionados con el manejo de datos judiciales en Argentina. Permite centralizar los esquemas de base de datos y mantenerlos actualizados de manera uniforme en todas las aplicaciones que lo utilicen.

## 🚀 Instalación

Para agregar este paquete a tu proyecto, instala directamente desde GitHub:

```bash
npm install git+https://github.com/cerramaximiliano/pjn-models.git
```

Si el paquete ya está definido en `package.json`, simplemente usa:

```bash
npm install
```

## 📌 Uso

Importa los modelos en cualquier parte de tu código y utilízalos como cualquier modelo de **Mongoose**:

```javascript
const { User, Causa } = require('pjn-models');
```

### 🔗 **Ejemplo: Conectar a MongoDB y consultar usuarios**

Asegúrate de establecer una conexión con **MongoDB** antes de usar los modelos:

```javascript
const mongoose = require('mongoose');
const { User } = require('pjn-models');

const conectarDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log("✅ Conectado a MongoDB");
    } catch (error) {
        console.error("❌ Error al conectar a MongoDB:", error);
        process.exit(1);
    }
};

conectarDB();

User.find().then(users => console.log(users));
```

## 🛠 Modelos Disponibles

| Modelo | Descripción |
|--------|------------|
| **User** | Almacena información de los usuarios (nombre, email, contraseña). |
| **Causa** | Representa causas judiciales con detalles como fuero, número y año. |

### 🔍 **Ejemplo: Crear un nuevo usuario**

```javascript
const { User } = require('pjn-models');

async function crearUsuario() {
    const nuevoUsuario = new User({
        name: "Maxi",
        email: "maxi@example.com",
        password: "123456"
    });
    await nuevoUsuario.save();
    console.log("✅ Usuario creado:", nuevoUsuario);
}

crearUsuario();
```

### 🔍 **Ejemplo: Buscar una causa por número y año**

```javascript
const { Causa } = require('pjn-models');

async function obtenerCausa() {
    const causa = await Causa.findOne({ numero: "12345", anio: 2024 });
    console.log("📄 Causa encontrada:", causa);
}

obtenerCausa();
```

## 🔄 Actualización del Paquete

Si `pjn-models` ya está instalado en tu proyecto y quieres asegurarte de que tienes la última versión, ejecuta:

```bash
npm install --force git+https://github.com/cerramaximiliano/pjn-models.git
```

Si el paquete ya está en `package.json`, simplemente ejecuta:

```bash
npm install
```

## 🛠 Desarrollo y Contribución

Si necesitas modificar los modelos:

1. Clona el repositorio:
   ```bash
   git clone https://github.com/cerramaximiliano/pjn-models.git
   cd pjn-models
   ```
2. Realiza las modificaciones necesarias en `src/models/`.
3. Confirma y sube los cambios:
   ```bash
   git add .
   git commit -m "🔄 Actualización de modelos"
   git push origin main
   ```
4. Actualiza los proyectos que usen el paquete:
   ```bash
   npm install
   ```

## 📜 Licencia

Este proyecto está bajo la **Licencia MIT** - ver el archivo `LICENSE` para más detalles.
