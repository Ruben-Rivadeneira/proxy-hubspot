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

app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    message: 'HubSpot Proxy API está funcionando!',
    timestamp: new Date().toISOString(),
    endpoints: {
      'GET /': 'Estado de la API',
      'GET /health': 'Health check',
      'POST /api/hubspot': 'Actualizar contacto en HubSpot',
      'POST /api/webhook': 'Procesar encuesta NPS desde HubSpot (requiere dealId y contactId)'
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

app.post('/api/hubspot', async (req, res) => {
  try {
    console.log('Datos recibidos:', req.body);
    
    const { id, data } = req.body;
    
    if (!id || !data) {
      return res.status(400).json({
        error: 'Faltan datos requeridos',
        required: { id: 'string', data: 'object' },
        received: { id: id ? 'true' : 'false', data: data ? 'true' : 'false' }
      });
    }
    
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) {
      return res.status(500).json({
        error: 'Token de HubSpot no configurado en variables de entorno'
      });
    }
    
    // Cambiado de deals a contacts
    const hubspotUrl = `https://api.hubapi.com/crm/v3/objects/contacts/${id}`;
    
    console.log('Enviando a HubSpot:', {
      url: hubspotUrl,
      contactId: id,
      properties: Object.keys(data)
    });
    
    const response = await axios.patch(hubspotUrl, {
      properties: data
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('HubSpot respondió exitosamente');
    
    return res.json({
      success: true,
      message: 'Contacto actualizado exitosamente en HubSpot',
      contactId: id,
      updatedAt: new Date().toISOString(),
      propertiesUpdated: Object.keys(data).length
    });
    
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    return res.status(500).json({
      error: 'Error al comunicarse con HubSpot',
      details: error.response?.data || error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/webhook', async (req, res) => {
  try {
    console.log('Webhook recibido:', req.body);
    
    const { dealId, contactId } = req.body;
    
    if (!dealId || !contactId) {
      return res.status(400).json({
        error: 'Faltan IDs requeridos',
        required: { dealId: 'string', contactId: 'string' },
        received: { dealId: dealId ? 'true' : 'false', contactId: contactId ? 'true' : 'false' }
      });
    }
    
    const hubspotToken = process.env.HUBSPOT_TOKEN;
    if (!hubspotToken) {
      return res.status(500).json({
        error: 'Token de HubSpot no configurado en variables de entorno'
      });
    }
    
    console.log('Paso 1: Obteniendo datos del negocio...');
    const dealData = await getDealData(dealId, hubspotToken);
    console.log('Datos negocio:', dealData);
    
    console.log('Paso 2: Obteniendo datos del contacto...');
    const contactData = await getContactData(contactId, hubspotToken);
    console.log('Datos contacto:', contactData);
    
    console.log('Paso 3: Obteniendo token de autenticación...');
    const authToken = await getAuthToken();
    
    console.log('Paso 4: Enviando encuesta a la API externa...');
    const surveyPayload = prepareSurveyPayload(dealData, contactData);
    console.log('Payload enviado a la API externa:', JSON.stringify(surveyPayload, null, 2));
    
    const result = await sendSurveyToAPI(surveyPayload, authToken);
    
    console.log('Proceso completado exitosamente');
    
    return res.json({
      success: true,
      message: 'Encuesta procesada y enviada exitosamente',
      dealId: dealId,
      contactId: contactId,
      processedAt: new Date().toISOString(),
      steps: {
        dealDataRetrieved: 'ok',
        contactDataRetrieved: 'ok',
        authTokenObtained: 'ok',
        surveySent: 'ok'
      },
      result: result
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
      {
        filters: [
          {
            propertyName: "hs_object_id",
            value: dealId,
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
    throw new Error('No se encontró el negocio');
  }
}

async function getContactData(contactId, token) {
  const url = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
  
  const payload = {
    properties: [
      "idnps",
      "contact_id",
      "firstname",
      "lastname",
      "phone",
      "email",
      "email_principal",
      "fechamail",
      "valornps",
      "mejoras",
      "comentario",
      "genero",
      "edadnps",
      "ropa",
      "zapatos",
      "talla_ropa",
      "adolecentes_adultos",
      "infantes",
      "ninos",
      "talla_zapatos",
      "actividad",
      "actividad_otros",
      "fechaencuesta"
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
    throw new Error('No se encontró el contacto');
  }
}

async function getAuthToken() {
  const url = 'https://apihubspot.cloudvolution.com.ec:8001/token';
  
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

function prepareSurveyPayload(dealData, contactData) {
  const now = new Date();
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const currentDate = `${now.getDate().toString().padStart(2, '0')}-${months[now.getMonth()]}-${now.getFullYear().toString().slice(-2)}`;
  
  return {
    idnps: contactData.idnps || uuidv4(),
    fechaencuesta: contactData.fechaencuesta || currentDate,
    valornps: sanitizeInteger(contactData.valornps),
    nrodocumento: "",
    concepto: dealData.concepto || "",
    local: dealData.centro || dealData.local || "",
    provincia: dealData.provincia_homologada || dealData.provincia || "",
    region: dealData.region || "",
    identificacion: contactData.contact_id || "",
    nombres: contactData.firstname || "",
    apellidos: contactData.lastname || "",
    mejoras: contactData.mejoras || "",
    comentario: contactData.comentario || "",
    telefono: contactData.phone || "",
    email: contactData.email || contactData.email_principal || "",
    localmcu: dealData.centro || dealData.local || "",
    fechaenvio: contactData.fechamail || currentDate,
    genero: sanitizeText(contactData.genero),
    edad: sanitizeInteger(contactData.edadnps),
    ropa: sanitizeText(contactData.ropa),
    zapatos: sanitizeText(contactData.zapatos),
    talla_ropa: sanitizeText(contactData.talla_ropa),
    adolecentes_adultos: sanitizeText(contactData.adolecentes_adultos),
    infantes: sanitizeText(contactData.infantes),
    ninos: sanitizeText(contactData.ninos),
    talla_zapatos: sanitizeText(contactData.talla_zapatos),
    actividad: sanitizeText(contactData.actividad),
    actividad_otros: sanitizeText(contactData.actividad_otros)
  };
}

function sanitizeText(value) {
  return (typeof value === 'string' && value.trim() !== "") ? value.trim() : null;
}

function sanitizeString(value) {
  if (value === null || value === undefined) return null;
  return String(value).trim() || null;
}

function sanitizeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? null : parsed;
}

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

// Endpoints de testing
app.post('/test/deal-data', async (req, res) => {
  try {
    const { dealId } = req.body;
    const token = process.env.HUBSPOT_TOKEN;
    
    if (!dealId || !token) {
      return res.status(400).json({ error: 'dealId o token faltante' });
    }
    
    const data = await getDealData(dealId, token);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/test/contact-data', async (req, res) => {
  try {
    const { contactId } = req.body;
    const token = process.env.HUBSPOT_TOKEN;
    
    if (!contactId || !token) {
      return res.status(400).json({ error: 'contactId o token faltante' });
    }
    
    const data = await getContactData(contactId, token);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/test/send-survey', async (req, res) => {
  try {
    const { dealData, contactData } = req.body;
    
    const authToken = await getAuthToken();
    const payload = prepareSurveyPayload(dealData, contactData);
    const response = await sendSurveyToAPI(payload, authToken);
    
    res.json({ success: true, payloadSent: payload, response });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Ruta no encontrada',
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

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
    console.log(`Endpoints disponibles:`);
    console.log(`  GET  http://localhost:${PORT}/`);
    console.log(`  GET  http://localhost:${PORT}/health`);
    console.log(`  POST http://localhost:${PORT}/api/hubspot`);
    console.log(`  POST http://localhost:${PORT}/api/webhook`);
  });
}

module.exports = app;
