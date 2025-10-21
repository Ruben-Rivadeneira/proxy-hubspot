const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Rutas
app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        message: 'HubSpot Contact+Deal Proxy API funcionando correctamente!',
        timestamp: new Date().toISOString(),
        endpoints: {
            'GET /': 'Estado de la API',
            'GET /health': 'Health check',
            'POST /api/webhook': 'Procesar encuesta NPS desde HubSpot',
            'POST /test/contact-data': 'Test de datos del contacto',
            'POST /test/deal-data': 'Test de datos del negocio'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Principal
app.post('/api/webhook', async (req, res) => {
    try {
        console.log('Webhook recibido:', req.body);

        const { dealId, contactId } = req.body;
        if (!dealId || !contactId) {
            return res.status(400).json({
                error: 'Faltan IDs requeridos',
                required: { dealId: 'string', contactId: 'string' },
                received: {
                    dealId: !!dealId,
                    contactId: !!contactId
                }
            });
        }

        const hubspotToken = process.env.HUBSPOT_TOKEN;
        if (!hubspotToken) {
            return res.status(500).json({
                error: 'Token de HubSpot no configurado en variables de entorno'
            });
        }

        console.log('Paso 1: Obteniendo datos del contacto...');
        const contactData = await getContactData(contactId, hubspotToken);
        console.log('Contacto:', contactData);

        console.log('Paso 2: Obteniendo datos del negocio...');
        const dealData = await getDealData(dealId, hubspotToken);
        console.log('Negocio:', dealData);

        console.log('Paso 3: Preparando payload...');
        const surveyPayload = prepareSurveyPayload(contactData, dealData);

        console.log('Payload combinado:', JSON.stringify(surveyPayload, null, 2));

        console.log('Paso 4: Actualizando contacto en HubSpot...');
        await updateContactData(contactId, surveyPayload, hubspotToken);

        console.log('Paso 5: Obteniendo token externo...');
        const authToken = await getAuthToken();

        console.log('Paso 6: Enviando encuesta a API externa...');
        const result = await sendSurveyToAPI(surveyPayload, authToken);

        console.log('Proceso completado exitosamente');

        return res.json({
            success: true,
            message: 'Encuesta procesada y enviada exitosamente',
            contactId,
            dealId,
            processedAt: new Date().toISOString(),
            steps: {
                contactDataRetrieved: 'ok',
                dealDataRetrieved: 'ok',
                contactUpdated: 'ok',
                authTokenObtained: 'ok',
                surveySent: 'ok'
            },
            result
        });

    } catch (error) {
        console.error('Error en webhook:', error.response?.data || error.message);
        return res.status(500).json({
            error: 'Error al procesar webhook',
            details: error.response?.data || error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Datos del contacto
async function getContactData(contactId, token) {
    const url = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
    const payload = {
        properties: [
            "contact_id", "firstname", "lastname", "phone", "email",
            "email_principal", "fechamail", "fechaencuesta", "valornps",
            "mejoras", "comentario", "genero", "edadnps", "ropa", "zapatos",
            "talla_ropa", "adolecentes_adultos", "infantes", "ninos",
            "talla_zapatos", "actividad", "actividad_otros", "idnps", "fecha_encuesta"
        ],
        filterGroups: [
            { filters: [{ propertyName: "hs_object_id", value: contactId, operator: "EQ" }] }
        ]
    };

    const response = await axios.post(url, payload, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });

    if (response.data.results?.length) {
        return response.data.results[0].properties;
    } else {
        throw new Error('No se encontró el contacto');
    }
}

// Datos del negocio
async function getDealData(dealId, token) {
    const url = 'https://api.hubapi.com/crm/v3/objects/deals/search';
    const payload = {
        properties: [
            "concepto",
            "local",
            "provincia",
            "region",
            "centro",
            "provincia_homologada"
        ],
        filterGroups: [
            { filters: [{ propertyName: "hs_object_id", value: dealId, operator: "EQ" }] }
        ]
    };

    const response = await axios.post(url, payload, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });

    if (response.data.results?.length) {
        return response.data.results[0].properties;
    } else {
        throw new Error('No se encontró el negocio');
    }
}

// Actualizar contacto en hubspot con valores de encuesta
async function updateContactData(contactId, data, token) {
    const url = `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`;
    const payload = { properties: data };

    await axios.patch(url, payload, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });

    console.log('Contacto actualizado correctamente en HubSpot');
}

// Token api externo
async function getAuthToken() {
    const url = 'https://apihubspot.cloudvolution.com.ec:8001/token';
    const params = new URLSearchParams();
    params.append('username', 'npshubspot');
    params.append('password', 'Hubspot');

    const response = await axios.post(url, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (response.data.access_token) return response.data.access_token;
    throw new Error('No se pudo obtener el token externo');
}

// preparar datos api externo
function prepareSurveyPayload(contactData, dealData) {
    const now = new Date();
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
        'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

    const currentDate = `${now.getDate().toString().padStart(2, '0')}-${months[now.getMonth()]}-${now.getFullYear().toString().slice(-2)}`;
    const formattedDate = `${now.getDate().toString().padStart(2, '0')}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()}`;

    const idnpsValue = contactData.idnps && contactData.idnps.trim() !== "" ? contactData.idnps : uuidv4();
    const fechaEncuesta = contactData.fechaencuesta || currentDate;

    return {
        idnps: idnpsValue,
        fechaencuesta: fechaEncuesta,
        fecha_encuesta: formattedDate,
        valornps: contactData.valornps || "",
        concepto: dealData.concepto || "",
        local: dealData.local || "",
        provincia: dealData.provincia_homologada || dealData.provincia || "",
        region: dealData.region || "",
        centro: dealData.centro || "",
        identificacion: contactData.contact_id || "",
        nombres: contactData.firstname || "",
        apellidos: contactData.lastname || "",
        mejoras: contactData.mejoras || "",
        comentario: contactData.comentario || "",
        telefono: contactData.phone || "",
        email: contactData.email || contactData.email_principal || "",
        fechaenvio: contactData.fechamail || currentDate,
        genero: sanitizeText(contactData.genero),
        edad: sanitizeString(contactData.edadnps),
        ropa: sanitizeText(contactData.ropa),
        zapatos: sanitizeText(contactData.zapatos),
        talla_ropa: sanitizeText(contactData.talla_ropa),
        adolecentes_adultos: sanitizeText(contactData.adolecentes_adultos),
        infantes: sanitizeText(contactData.infantes),
        ninos: sanitizeText(contactData.ninos),
        talla_zapatos: sanitizeString(contactData.talla_zapatos),
        actividad: sanitizeText(contactData.actividad),
        actividad_otros: sanitizeText(contactData.actividad_otros)
    };
}

// formatear valores
function sanitizeText(value) {
    return (typeof value === 'string' && value.trim() !== "") ? value.trim() : null;
}
function sanitizeString(value) {
    if (value === null || value === undefined) return null;
    return String(value).trim() || null;
}

// Envio de encuesta a api externo
async function sendSurveyToAPI(payload, token) {
    const url = 'https://apihubspot.cloudvolution.com.ec:8001/encuesta';
    const response = await axios.post(url, payload, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });
    return response.data;
}

// test
app.post('/test/contact-data', async (req, res) => {
    try {
        const { contactId } = req.body;
        const token = process.env.HUBSPOT_TOKEN;
        const data = await getContactData(contactId, token);
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/test/deal-data', async (req, res) => {
    try {
        const { dealId } = req.body;
        const token = process.env.HUBSPOT_TOKEN;
        const data = await getDealData(dealId, token);
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// handler
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Ruta no encontrada',
        availableRoutes: [
            'GET /',
            'GET /health',
            'POST /api/webhook',
            'POST /test/contact-data',
            'POST /test/deal-data'
        ]
    });
});

// iniciar servidor
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
}

module.exports = app;
