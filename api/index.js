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
      'POST /api/webhook': 'Procesar encuesta NPS (requiere dealId y contactId)'
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
    console.log('Datos recibidos desde la landing:', req.body);

    const { id, data } = req.body;

    if (!id || !data) {
      return res.status(400).json({
        error: 'Faltan datos requeridos',
        required: { id: 'string', data: 'object' },
        received: {
          id: id ? 'true' : 'false',
          data: data ? 'true' : 'false'
        }
      });
    }

    const token = process.env.HUBSPOT_TOKEN;
    if (!token) {
      return res.status(500).json({
        error: 'Token de HubSpot no configurado en variables de entorno'
      });
    }

    if (data.fechaencuesta) {
      const [day, month, year] = new Date().toLocaleDateString('es-ES').split('/');
      const timestamp = new Date(+year, +month - 1, +day).getTime();
      data.fecha_encuesta = timestamp;
    }

    const hubspotUrl = `https://api.hubapi.com/crm/v3/objects/contacts/${id}`;
    console.log('Enviando actualización a HubSpot:', {
      url: hubspotUrl,
      contactId: id,
      properties: Object.keys(data)
    });

    const response = await axios.patch(
      hubspotUrl,
      { properties: data },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Contacto actualizado exitosamente en HubSpot');

    return res.json({
      success: true,
      message: 'Contacto actualizado exitosamente en HubSpot',
      contactId: id,
      updatedAt: new Date().toISOString(),
      propertiesUpdated: Object.keys(data).length
    });

  } catch (error) {
    console.error('Error al actualizar contacto en HubSpot:', error.response?.data || error.message);

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
        received: {
          dealId: dealId ? 'true' : 'false',
          contactId: contactId ? 'true' : 'false'
        }
      });
    }

    console.log('Webhook recibido: ', { dealId, contactId });

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

    console.log('Paso 3: Preparando payload para API externa...');
    const authToken = await getAuthToken();
    const surveyPayload = prepareSurveyPayload(dealData, contactData);
    console.log('Payload a enviar:', JSON.stringify(surveyPayload, null, 2));

    const result = await sendSurveyToAPI(surveyPayload, authToken);

    console.log('Encuesta enviada exitosamente a la API externa');

    return res.json({
      success: true,
      message: 'Encuesta procesada correctamente',
      contactId,
      dealId,
      processedAt: new Date().toISOString(),
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

async function getDealData(dealId, token) {
  const url = 'https://api.hubapi.com/crm/v3/objects/deals/search';
  const payload = {
    properties: ["concepto", "local", "provincia", "region", "centro", "provincia_homologada", "region"],
    filterGroups: [{ filters: [{ propertyName: "hs_object_id", value: dealId, operator: "EQ" }] }]
  };

  const response = await axios.post(url, payload, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  });

  if (response.data.results?.length > 0) return response.data.results[0].properties;
  throw new Error('No se encontró el negocio con los datos solicitados');
}

async function getContactData(contactId, token) {
  const url = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
  const payload = {
    properties: [
      "contact_id", "firstname", "lastname", "phone", "email", "email_principal", "fechamail",
      "valornps", "mejoras", "comentario", "genero", "edad", "ropa", "zapatos", "talla_ropa",
      "adolecentes_adultos", "infantes", "ninos", "talla_zapatos", "actividad", "actividad_otros", "fechaencuesta"
    ],
    filterGroups: [{ filters: [{ propertyName: "hs_object_id", value: contactId, operator: "EQ" }] }]
  };

  const response = await axios.post(url, payload, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  });

  if (response.data.results?.length > 0) return response.data.results[0].properties;
  throw new Error('No se encontró el contacto');
}

async function getAuthToken() {
  const url = 'https://apihubspot.cloudvolution.com.ec:8001/token';
  const params = new URLSearchParams();
  params.append('username', 'npshubspot');
  params.append('password', 'Hubspot');

  const response = await axios.post(url, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  if (response.data.access_token) return response.data.access_token;
  throw new Error('No se pudo obtener el token de autenticación');
}

function prepareSurveyPayload(dealData, contactData) {
  const now = new Date();
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const currentDate = `${now.getDate().toString().padStart(2, '0')}-${months[now.getMonth()]}-${now.getFullYear().toString().slice(-2)}`;

  return {
    idnps: uuidv4(),
    fechaencuesta: contactData.fechaencuesta || currentDate,
    valornps: contactData.valornps || "",
    concepto: dealData.concepto || "",
    local: dealData.local || "",
    provincia: dealData.provincia_homologada || dealData.provincia || "",
    region: dealData.region || "",
    nrodocumento: contactData.contact_id || "",
    nombres: contactData.firstname || "",
    apellidos: contactData.lastname || "",
    mejoras: contactData.mejoras || "",
    comentario: contactData.comentario || "",
    telefono: contactData.phone || "",
    email: contactData.email || contactData.email_principal || "",
    fechaenvio: contactData.fechamail || currentDate,
    genero: contactData.genero || "",
    edad: contactData.edad || "",
    ropa: contactData.ropa || "",
    zapatos: contactData.zapatos || "",
    talla_ropa: contactData.talla_ropa || "",
    adolecentes_adultos: contactData.adolecentes_adultos || "",
    infantes: contactData.infantes || "",
    ninos: contactData.ninos || "",
    talla_zapatos: contactData.talla_zapatos || "",
    actividad: contactData.actividad || "",
    actividad_otros: contactData.actividad_otros || ""
  };
}

async function sendSurveyToAPI(payload, token) {
  const url = 'https://apihubspot.cloudvolution.com.ec:8001/encuesta';
  const response = await axios.post(url, payload, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  return response.data;
}

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
  });
}

module.exports = app;
