const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

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
            'POST /api/hubspot': 'Actualizar deal en HubSpot',
            'POST /api/webhook': 'Procesar encuesta NPS desde HubSpot (requiere dealId y contactId)'
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

// Nuevo endpoint para webhook de encuestas NPS
app.post('/api/webhook', async (req, res) => {
    try {
        console.log('📨 Webhook recibido:', req.body);

        const { dealId, contactId } = req.body;

        // Validación de IDs
        if (!dealId || !contactId) {
            return res.status(400).json({
                error: '❌ Faltan IDs requeridos',
                required: { dealId: 'string', contactId: 'string' },
                received: {
                    dealId: dealId ? '✅' : '❌',
                    contactId: contactId ? '✅' : '❌'
                }
            });
        }

        // Verificar token de HubSpot
        const hubspotToken = process.env.HUBSPOT_TOKEN;
        if (!hubspotToken) {
            return res.status(500).json({
                error: '❌ Token de HubSpot no configurado en variables de entorno'
            });
        }

        console.log('🔍 Paso 1: Obteniendo datos de encuesta del contacto...');

        // Paso 1: Obtener datos de encuesta del contacto
        const encuestaData = await getDealData(contactId, hubspotToken);

        console.log('🔍 Paso 2: Obteniendo datos básicos del contacto...');

        // Paso 2: Obtener datos básicos del contacto
        const contactData = await getContactData(contactId, hubspotToken);

        console.log('🔑 Paso 3: Obteniendo token de autenticación...');

        // Paso 3: Obtener token de autenticación para la API externa
        const authToken = await getAuthToken();

        console.log('📤 Paso 4: Enviando encuesta a la API externa...');

        // Paso 4: Preparar y enviar datos a la API externa
        const surveyPayload = prepareSurveyPayload(encuestaData, contactData);
        const result = await sendSurveyToAPI(surveyPayload, authToken);

        console.log('✅ Proceso completado exitosamente');

        return res.json({
            success: true,
            message: '✅ Encuesta procesada y enviada exitosamente',
            dealId: dealId,
            contactId: contactId,
            processedAt: new Date().toISOString(),
            steps: {
                surveyDataRetrieved: '✅',
                contactDataRetrieved: '✅',
                authTokenObtained: '✅',
                surveySent: '✅'
            },
            result: result
        });

    } catch (error) {
        console.error('💥 Error en webhook:', error.response?.data || error.message);

        return res.status(500).json({
            error: '💥 Error al procesar webhook',
            details: error.response?.data || error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Función para obtener datos de encuesta del contacto
async function getDealData(contactId, token) {
    const url = 'https://api.hubapi.com/crm/v3/objects/deals/search';
    const payload = {
        properties: [
            "fechaencuesta",
            "valornps",
            "concepto",
            "local",
            "provincia",
            "region",
            "mejoras",
            "comentario",
            "centro",
            "provincia_homologada",
            "region",
            "genero",
            "edad",
            "ropa",
            "zapatos",
            "talla_ropa",
            "adolecentes_adultos",
            "infantes",
            "ninos",
            "talla_zapatos",
            "actividad",
            "actividad_otros"
        ],
        filterGroups: [
            {
                filters: [
                    {
                        propertyName: "hs_object_id",
                        value: contactId,
                        operator: "EQ"
                    }
                ]
            }
        ]
    };

    const response = await axios.post(url, payload, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });

    if (response.data.results && response.data.results.length > 0) {
        return response.data.results[0].properties;
    } else {
        throw new Error('No se encontró el contacto con los datos de encuesta');
    }
}

// Función para obtener datos básicos del contacto
async function getContactData(contactId, token) {
    const url = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
    const payload = {
        properties: [
            "contact_id",
            "firstname",
            "lastname",
            "phone",
            "email",
            "email_principal"
        ],
        filterGroups: [
            {
                filters: [
                    {
                        propertyName: "hs_object_id",
                        value: contactId,
                        operator: "EQ"
                    }
                ]
            }
        ]
    };

    const response = await axios.post(url, payload, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });

    if (response.data.results && response.data.results.length > 0) {
        return response.data.results[0].properties;
    } else {
        throw new Error('No se encontró el contacto con los datos básicos');
    }
}

// Función para obtener token de autenticación
async function getAuthToken() {
    const url = 'http://35.188.96.105:8001/token';
    const params = new URLSearchParams();
    params.append('username', 'npshubspot');
    params.append('password', 'Hubspot');

    const response = await axios.post(url, params, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });

    if (response.data.access_token) {
        return response.data.access_token;
    } else {
        throw new Error('No se pudo obtener el token de autenticación');
    }
}

// Función para preparar el payload de la encuesta
function prepareSurveyPayload(surveyData, contactData) {
    // Obtener fecha actual en formato DD-MMM-YY
    const now = new Date();
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
        'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const currentDate = `${now.getDate().toString().padStart(2, '0')}-${months[now.getMonth()]}-${now.getFullYear().toString().slice(-2)}`;

    return {
        idnps: uuidv4(), // ID fijo según ejemplo
        fechaencuesta: surveyData.fechaencuesta || currentDate,
        valornps: surveyData.valornps || "",
        nrodocumento: contactData.contact_id || "",
        concepto: surveyData.concepto || "",
        local: surveyData.local || "",
        provincia: surveyData.provincia || "",
        region: surveyData.region || "",
        identificacion: contactData.contact_id || "",
        nombres: contactData.firstname || "",
        apellidos: contactData.lastname || "",
        mejoras: surveyData.mejoras || "",
        comentario: surveyData.comentario || "",
        telefono: contactData.phone || "",
        email: contactData.email || contactData.email_principal || "",
        localmcu: surveyData.localmcu || surveyData.local || "",
        fechaenvio: currentDate,
        genero: surveyData.genero || "",
        edad: surveyData.edad || "",
        ropa: surveyData.ropa || "",
        zapatos: surveyData.zapatos || "",
        talla_ropa: surveyData.talla_ropa || "",
        adolecentes_adultos: surveyData.adolecentes_adultos || "",
        infantes: surveyData.infantes || "",
        ninos: surveyData.ninos || "",
        talla_zapatos: surveyData.talla_zapatos || "",
        actividad: surveyData.actividad || "",
        actividad_otros: surveyData.actividad_otros || ""
    };
}

// Función para enviar encuesta a la API externa
async function sendSurveyToAPI(payload, token) {
    const url = 'http://35.188.96.105:8001/encuesta';

    const response = await axios.post(url, payload, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });

    return response.data;
}

// Manejo de rutas no encontradas
app.use('*', (req, res) => {
    res.status(404).json({
        error: '🔍 Ruta no encontrada',
        path: req.originalUrl,
        method: req.method,
        availableRoutes: [
            'GET /',
            'GET /health',
            'POST /api/hubspot',
            'POST /api/webhook'
        ]
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
        console.log(`   POST http://localhost:${PORT}/api/webhook`);
    });
}

module.exports = app;