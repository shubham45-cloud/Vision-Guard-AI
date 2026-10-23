
import axios from "axios";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "/",
  timeout: 600000,
});

export async function checkBackendHealth() {
  const response = await api.get("/health");
  return response.data;
}

export async function analyzeVideo(
  file,
  confidenceThreshold = 0.4,
  restrictedZone = null,
) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("confidence_threshold", String(confidenceThreshold));
  if (restrictedZone) {
    formData.append("restricted_zone", JSON.stringify(restrictedZone));
  }

  const response = await api.post(
    "/api/videos/analyze",
    formData
  );

  return response.data;
}

export async function getDashboardSummary() {
  const response = await api.get("/api/dashboard");
  return response.data.summary;
}

export async function getIncidents() {
  const response = await api.get("/api/incidents");
  return response.data.incidents;
}

export async function updateIncidentStatus(incidentId, status) {
  const response = await api.patch(
    `/api/incidents/${encodeURIComponent(incidentId)}/status`,
    { status },
  );
  return response.data.incident;
}

export async function getIncidentEvidence(incidentId) {
  const response = await api.get(
    `/api/incidents/${encodeURIComponent(incidentId)}/evidence`,
    { responseType: "blob" },
  );
  return response.data;
}

export async function recoverIncidentEvidence(incidentId, file) {
  const formData = new FormData();
  formData.append("file", file);
  const response = await api.post(
    `/api/incidents/${encodeURIComponent(incidentId)}/evidence/recover`,
    formData,
    { responseType: "blob" },
  );
  return response.data;
}

export default api;
