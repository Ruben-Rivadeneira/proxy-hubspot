const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Ruta raíz
app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        message: '🚀 HubSpot Proxy API está funcionando!',
        timestamp: new Date().toISOString(),
        endpoints: {
            'GET /': 'Estado de la API',
            'GET /health': 'Health check',
            'POST /api/hubspot': 'Actualizar deal en HubSpot'
        }
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Endpoint principal para HubSpot
app.post('/api/hubspot', async (req, res) => {
    try {
        console.log('📨 Datos recibidos:', req.body);
        
        const { id, data } = req.body;

        // Validación
        if (!id || !data) {
            return res.status(400).json({
                error: '❌ Faltan datos requeridos',
                required: { id: 'string', data: 'object' },
                received: { 
                    id: id ? '✅' : '❌', 
                    data: data ? '✅' : '❌' 
                }
            });
        }

        // Verificar token
        const token = process.env.HUBSPOT_TOKEN;
        if (!token) {
            return res.status(500).json({
                error: '❌ Token de HubSpot no configurado en variables de entorno'
            });
        }

        // Preparar petición a HubSpot
        const hubspotUrl = `https://api.hubapi.com/crm/v3/objects/deals/${id}`;
        
        console.log('🎯 Enviando a HubSpot:', {
            url: hubspotUrl,
            dealId: id,
            properties: Object.keys(data)
        });

        // Llamada a HubSpot
        const response = await axios.patch(hubspotUrl, 
            { properties: data }, 
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('✅ HubSpot respondió exitosamente');

        return res.json({
            success: true,
            message: '✅ Deal actualizado exitosamente en HubSpot',
            dealId: id,
            updatedAt: new Date().toISOString(),
            propertiesUpdated: Object.keys(data).length
        });

    } catch (error) {
        console.error('💥 Error:', error.response?.data || error.message);
        
        return res.status(500).json({
            error: '💥 Error al comunicarse con HubSpot',
            details: error.response?.data || error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Manejo de rutas no encontradas
app.use('*', (req, res) => {
    res.status(404).json({
        error: '🔍 Ruta no encontrada',
        path: req.originalUrl,
        method: req.method,
        availableRoutes: ['GET /', 'GET /health', 'POST /api/hubspot']
    });
});

// Solo para desarrollo local
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🌟 Servidor corriendo en http://localhost:${PORT}`);
        console.log(`📋 Endpoints disponibles:`);
        console.log(`   GET  http://localhost:${PORT}/`);
        console.log(`   GET  http://localhost:${PORT}/health`);
        console.log(`   POST http://localhost:${PORT}/api/hubspot`);
    });
}

module.exports = app;