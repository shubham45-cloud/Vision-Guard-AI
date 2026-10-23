import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bell,
  ChevronDown,
  ChevronRight,
  Circle,
  Download,
  Gauge,
  Home,
  ImageIcon,
  ListFilter,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Upload,
  UserCircle2,
  Video,
  Zap,
  X,
} from "lucide-react";

import {
  analyzeVideo,
  checkBackendHealth,
  getIncidentEvidence,
  getDashboardSummary,
  getIncidents,
  recoverIncidentEvidence,
  updateIncidentStatus,
} from "./services/api";
import "./App.css";

const navItems = [
  { label: "Overview", icon: Home },
  { label: "Incidents", icon: ShieldAlert },
  { label: "Cameras", icon: Video },
  { label: "Reports", icon: TrendingUp },
  { label: "Settings", icon: Settings },
];

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function isWithinPeriod(value, period) {
  if (period === "all") return true;

  const timestamp = new Date(value).getTime();
  const periodLength = period === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const age = Date.now() - timestamp;
  return Number.isFinite(timestamp) && age >= 0 && age <= periodLength;
}

function readSavedConfidenceThreshold() {
  try {
    const savedThreshold = Number(localStorage.getItem("visionguard-confidence-threshold"));
    return Number.isFinite(savedThreshold) && savedThreshold >= 0.05 && savedThreshold <= 0.95
      ? savedThreshold
      : 0.4;
  } catch (error) {
    console.warn("Unable to read the saved confidence threshold.", error);
    return 0.4;
  }
}

function App() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState(null);
  const [confidenceThreshold, setConfidenceThreshold] = useState(readSavedConfidenceThreshold);
  const [selectedFrame, setSelectedFrame] = useState(null);
  const [selectedIncident, setSelectedIncident] = useState(null);
  const [incidentEvidenceUrl, setIncidentEvidenceUrl] = useState("");
  const [incidentEvidenceLoading, setIncidentEvidenceLoading] = useState(false);
  const [recoveringIncidentEvidence, setRecoveringIncidentEvidence] = useState(false);
  const [incidentEvidenceError, setIncidentEvidenceError] = useState("");
  const [incidentStatusError, setIncidentStatusError] = useState("");
  const [updatingIncidentIds, setUpdatingIncidentIds] = useState([]);
  const [activePage, setActivePage] = useState("Overview");
  const [incidents, setIncidents] = useState([]);
  const [dashboardSummary, setDashboardSummary] = useState(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [dashboardLoadError, setDashboardLoadError] = useState("");
  const [incidentLoadError, setIncidentLoadError] = useState("");
  const [incidentSearch, setIncidentSearch] = useState("");
  const [incidentPeriod, setIncidentPeriod] = useState("all");
  const [zoneFilter, setZoneFilter] = useState("All zones");
  const [incidentPage, setIncidentPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [reportMessage, setReportMessage] = useState("");
  const [restrictedZone, setRestrictedZone] = useState(null);
  const [zoneEditorOpen, setZoneEditorOpen] = useState(false);
  const [zoneDraft, setZoneDraft] = useState([]);
  const [zoneFrame, setZoneFrame] = useState(null);
  const [cameraStream, setCameraStream] = useState(null);
  const [cameraConnecting, setCameraConnecting] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [backendConnected, setBackendConnected] = useState(null);
  const selectedIncidentId = selectedIncident?.id;
  const annotatedFrames =
    results?.results?.annotated_frames || results?.annotated_frames || [];

  const availableZones = useMemo(
    () => [...new Set(incidents.map(({ zone_name }) => zone_name))].sort(),
    [incidents],
  );
  const filteredIncidents = useMemo(() => {
    const query = incidentSearch.trim().toLowerCase();

    return incidents
      .filter((incident) => {
        const matchesZone = zoneFilter === "All zones" || incident.zone_name === zoneFilter;
        const matchesPeriod = isWithinPeriod(incident.created_at, incidentPeriod);
        const matchesSearch =
          !query ||
          [
            incident.class_name,
            incident.zone_name,
            incident.video_filename,
          ].some((value) => value?.toLowerCase().includes(query));

        return matchesZone && matchesPeriod && matchesSearch;
      })
      .sort(
        (left, right) =>
          new Date(right.created_at).getTime() - new Date(left.created_at).getTime(),
      );
  }, [incidents, incidentPeriod, incidentSearch, zoneFilter]);
  const incidentsPerPage = 50;
  const incidentPageCount = Math.max(1, Math.ceil(filteredIncidents.length / incidentsPerPage));
  const paginatedIncidents = filteredIncidents.slice(
    (incidentPage - 1) * incidentsPerPage,
    incidentPage * incidentsPerPage,
  );
  const incidentsByZone = useMemo(() => {
    const groups = new Map();

    for (const incident of filteredIncidents) {
      const key = `${incident.video_filename}\u0000${incident.zone_name}`;
      const group = groups.get(key) || {
        source: incident.video_filename,
        zone: incident.zone_name,
        incident_count: 0,
        last_incident_at: incident.created_at,
      };
      group.incident_count += 1;
      if (new Date(incident.created_at) > new Date(group.last_incident_at)) {
        group.last_incident_at = incident.created_at;
      }
      groups.set(key, group);
    }

    return [...groups.values()].sort(
      (left, right) => right.incident_count - left.incident_count,
    );
  }, [filteredIncidents]);
  const sourceVideoSummary = useMemo(() => {
    const groups = new Map();

    for (const incident of incidents) {
      const group = groups.get(incident.video_filename) || {
        filename: incident.video_filename,
        incident_count: 0,
        last_incident_at: incident.created_at,
      };
      group.incident_count += 1;
      if (new Date(incident.created_at) > new Date(group.last_incident_at)) {
        group.last_incident_at = incident.created_at;
      }
      groups.set(incident.video_filename, group);
    }

    return [...groups.values()].sort(
      (left, right) => right.incident_count - left.incident_count,
    );
  }, [incidents]);
  const reportClassCounts = useMemo(
    () => filteredIncidents.reduce((counts, incident) => {
      counts[incident.class_name] = (counts[incident.class_name] || 0) + 1;
      return counts;
    }, {}),
    [filteredIncidents],
  );
  const incidentFilterControls = (
    <div className="filter-controls">
      <label>
        Time range
        <select
          aria-label="Incident time range"
          value={incidentPeriod}
          onChange={(event) => {
            setIncidentPeriod(event.target.value);
            setIncidentPage(1);
          }}
        >
          <option value="all">All time</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
        </select>
      </label>
      <label>
        Zone
        <select
          aria-label="Incident zone filter"
          value={zoneFilter}
          onChange={(event) => {
            setZoneFilter(event.target.value);
            setIncidentPage(1);
          }}
        >
          <option>All zones</option>
          {availableZones.map((zone) => <option key={zone}>{zone}</option>)}
        </select>
      </label>
      <span>
        Showing {filteredIncidents.length.toLocaleString()} of {incidents.length.toLocaleString()} incidents
      </span>
    </div>
  );

  const backendStatus = useMemo(() => {
    if (backendConnected === null) return { label: "Checking backend", tone: "" };
    return backendConnected
      ? { label: "Backend online", tone: "text-green" }
      : { label: "Backend unavailable", tone: "text-red" };
  }, [backendConnected]);

  const loadDashboardData = useCallback(() => Promise.allSettled([
      getDashboardSummary(),
      getIncidents(),
      checkBackendHealth(),
    ]), []);
  const applyDashboardData = useCallback(([summaryResult, incidentsResult, healthResult]) => {
    if (summaryResult.status === "fulfilled") {
      setDashboardSummary(summaryResult.value);
      setDashboardLoadError("");
    } else {
      setDashboardLoadError(
        summaryResult.reason.message || "Unable to load dashboard metrics.",
      );
    }
    if (incidentsResult.status === "fulfilled") {
      setIncidents(incidentsResult.value);
      setIncidentLoadError("");
    } else {
      setIncidentLoadError(
        incidentsResult.reason.message || "Unable to load saved incidents.",
      );
    }
    if (healthResult.status === "fulfilled") {
      setBackendConnected(healthResult.value?.status === "healthy");
    } else {
      setBackendConnected(false);
    }
    setDashboardLoading(false);
  }, []);

  const refreshDashboardData = useCallback(async () => {
    setIsRefreshing(true);
    setIncidentPage(1);
    applyDashboardData(await loadDashboardData());
    setIsRefreshing(false);
  }, [applyDashboardData, loadDashboardData]);

  useEffect(() => {
    let isMounted = true;
    loadDashboardData().then((results) => {
      if (isMounted) {
        applyDashboardData(results);
        setIsRefreshing(false);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [applyDashboardData, loadDashboardData]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "visionguard-confidence-threshold",
        String(confidenceThreshold),
      );
    } catch (error) {
      console.warn("Unable to save the confidence threshold in this browser.", error);
    }
  }, [confidenceThreshold]);

  useEffect(() => {
    if (!cameraStream) return undefined;

    const tracks = cameraStream.getTracks();
    const handleTrackEnded = () => setCameraStream(null);
    tracks.forEach((track) => track.addEventListener("ended", handleTrackEnded));

    return () => {
      tracks.forEach((track) => {
        track.removeEventListener("ended", handleTrackEnded);
        track.stop();
      });
    };
  }, [cameraStream]);

  async function startCameraStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError("This browser does not support live camera access.");
      return;
    }

    try {
      setCameraConnecting(true);
      setCameraError("");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      setCameraStream(stream);
    } catch (error) {
      setCameraError(error.message || "Unable to access the camera.");
    } finally {
      setCameraConnecting(false);
    }
  }

  function stopCameraStream() {
    cameraStream?.getTracks().forEach((track) => track.stop());
    setCameraStream(null);
  }

  useEffect(() => {
    if (!selectedFrame) {
      return undefined;
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setSelectedFrame(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedFrame]);

  useEffect(() => {
    if (!selectedIncidentId) {
      return undefined;
    }

    let isActive = true;

    getIncidentEvidence(selectedIncidentId)
      .then((imageBlob) => {
        if (isActive) {
          setIncidentEvidenceUrl(URL.createObjectURL(imageBlob));
        }
      })
      .catch((loadError) => {
        if (isActive) {
          setIncidentEvidenceError(
            loadError.response?.status === 404
              ? "Annotated evidence is not available for this incident. Older incidents were saved before evidence capture was enabled."
              : loadError.message || "Unable to load incident evidence.",
          );
        }
      })
      .finally(() => {
        if (isActive) setIncidentEvidenceLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, [selectedIncidentId]);

  useEffect(() => {
    return () => {
      if (incidentEvidenceUrl) URL.revokeObjectURL(incidentEvidenceUrl);
    };
  }, [incidentEvidenceUrl]);

  function openIncidentDetails(incident) {
    setIncidentEvidenceLoading(true);
    setIncidentEvidenceError("");
    setIncidentEvidenceUrl("");
    setSelectedIncident(incident);
  }

  async function handleRecoverIncidentEvidence(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selectedIncident) return;

    if (file.name !== selectedIncident.video_filename) {
      setIncidentEvidenceError(
        `Choose the original source video named "${selectedIncident.video_filename}".`,
      );
      return;
    }

    setRecoveringIncidentEvidence(true);
    setIncidentEvidenceLoading(true);
    setIncidentEvidenceError("");
    try {
      const imageBlob = await recoverIncidentEvidence(selectedIncident.id, file);
      const evidenceUrl = URL.createObjectURL(imageBlob);
      setIncidentEvidenceUrl(evidenceUrl);
      setIncidents((current) =>
        current.map((incident) =>
          incident.id === selectedIncident.id
            ? { ...incident, evidence_filename: "recovered" }
            : incident,
        ),
      );
      setSelectedIncident((current) =>
        current?.id === selectedIncident.id
          ? { ...current, evidence_filename: "recovered" }
          : current,
      );
    } catch (loadError) {
      setIncidentEvidenceError(
        loadError.response?.data?.detail ||
          loadError.message ||
          "Unable to regenerate incident evidence.",
      );
    } finally {
      setIncidentEvidenceLoading(false);
      setRecoveringIncidentEvidence(false);
    }
  }

  async function handleIncidentStatusChange(incidentId, status) {
    setUpdatingIncidentIds((current) => [...current, incidentId]);
    setIncidentStatusError("");
    try {
      const updatedIncident = await updateIncidentStatus(incidentId, status);
      setIncidents((current) =>
        current.map((incident) =>
          incident.id === incidentId ? updatedIncident : incident,
        ),
      );
      setSelectedIncident((current) =>
        current?.id === incidentId ? updatedIncident : current,
      );
    } catch (statusError) {
      setIncidentStatusError(
        statusError.response?.data?.detail ||
          statusError.message ||
          "Unable to update incident status.",
      );
    } finally {
      setUpdatingIncidentIds((current) =>
        current.filter((id) => id !== incidentId),
      );
    }
  }

  async function handleAnalyze() {
    if (!selectedFile) {
      setError("Choose a video to analyze before sending it to the backend.");
      return;
    }

    setIsAnalyzing(true);
    setError("");

    try {
      const health = await checkBackendHealth();
      if (health?.status !== "healthy") {
        throw new Error("Backend is not currently healthy.");
      }

      const response = await analyzeVideo(
        selectedFile,
        confidenceThreshold,
        restrictedZone,
      );
      setResults(response);
      await refreshDashboardData();
    } catch (err) {
      setError(err.message || "Unable to analyze the selected video.");
      setResults(null);
    } finally {
      setIsAnalyzing(false);
    }
  }

  function downloadReport() {
    const columns = [
      "id",
      "created_at",
      "video_filename",
      "frame",
      "class_name",
      "confidence",
      "zone_name",
      "status",
      "point_x",
      "point_y",
    ];
    const escapeCsv = (value) => {
      const text = String(value ?? "");
      const safeText = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      return `"${safeText.replaceAll('"', '""')}"`;
    };
    const csv = [
      columns.join(","),
      ...filteredIncidents.map((incident) =>
        columns.map((column) => escapeCsv(incident[column])).join(","),
      ),
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `visionguard-incidents-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setReportMessage(`Exported ${filteredIncidents.length.toLocaleString()} incident records.`);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <ShieldCheck size={18} />
          </div>
          <div>
            <strong>VisionGuard</strong>
            <span>SECURITY OPS</span>
          </div>
        </div>

        <div className="workspace-label">Workspace</div>

        <nav>
          {navItems.map(({ label, icon: Icon }) => (
            <button
              key={label}
              type="button"
              className={`nav-item ${activePage === label ? "nav-active" : ""}`}
              onClick={() => setActivePage(label)}
            >
              <Icon size={14} />
              <span>{label}</span>
              {label === "Settings" ? <ChevronDown size={12} className="nav-chevron" /> : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="system-status">
            <span className={`status-dot ${backendConnected === false ? "status-dot-offline" : backendConnected === null ? "status-dot-unknown" : ""}`} />
            <div>
              <strong>{backendStatus.label}</strong>
              <small>API health check</small>
            </div>
          </div>

          <div className="user-profile">
            <div className="avatar">AG</div>
            <div>
              <strong>Shubham</strong>
              <span>Operations lead</span>
            </div>
            <ChevronDown size={14} />
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <ChevronRight size={12} />
            <span>Incident monitoring</span>
            <ChevronRight size={12} />
            <strong>{activePage}</strong>
          </div>

          <div className="topbar-right">
            <div className="search-box">
              <Search size={12} />
              <input
                aria-label="Search incidents"
                placeholder="Search incidents"
                value={incidentSearch}
                onChange={(event) => {
                  setIncidentSearch(event.target.value);
                  setIncidentPage(1);
                }}
              />
            </div>

            <button
              type="button"
              className="icon-button notification-button"
              aria-label="View saved incidents"
              title="View saved incidents"
              onClick={() => {
                setIncidentSearch("");
                setIncidentPeriod("all");
                setZoneFilter("All zones");
                setIncidentPage(1);
                setActivePage("Incidents");
              }}
            >
              <Bell size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh dashboard data"
              title="Refresh dashboard data"
              disabled={isRefreshing}
              onClick={refreshDashboardData}
            >
              <RefreshCw size={14} className={isRefreshing ? "spin" : ""} />
            </button>

            <div className="top-avatar">AG</div>
            <div className="top-user">
              <strong>Shubham</strong>
              <span>Command center</span>
            </div>
          </div>
        </header>

        <div className="page-content">
          {activePage === "Overview" ? (
            <>
          <div className="page-heading">
            <div>
              <h1>Security overview</h1>
              <p>Saved restricted-zone detections and the current video analysis settings.</p>
            </div>
            <div>
              <button
                type="button"
                className="secondary-button"
                aria-expanded={showFilters}
                onClick={() => setShowFilters((visible) => !visible)}
              >
                <ListFilter size={12} />
                {showFilters ? "Hide filters" : "Filter view"}
              </button>
            </div>
          </div>

          {showFilters ? incidentFilterControls : null}
          {dashboardLoadError ? (
            <div className="notice error-notice">{dashboardLoadError}</div>
          ) : null}
          {incidentLoadError ? (
            <div className="notice error-notice">{incidentLoadError}</div>
          ) : null}

          <div className="stats-grid">
            {[
              {
                label: "Frames with incidents",
                value: dashboardLoading ? "…" : dashboardSummary?.frames_with_incidents?.toLocaleString() ?? "—",
                note: "Distinct saved frames",
                tone: "blue",
                icon: Gauge,
              },
              {
                label: "Incident detections",
                value: dashboardLoading ? "…" : dashboardSummary?.threat_alerts?.toLocaleString() ?? "—",
                note: "Restricted-zone detections",
                tone: "red",
                icon: ShieldAlert,
              },
              {
                label: "People detections",
                value: dashboardLoading ? "…" : dashboardSummary?.people_tracked?.toLocaleString() ?? "—",
                note: "Saved person detections",
                tone: "purple",
                icon: UserCircle2,
              },
              {
                label: "Videos with incidents",
                value: dashboardLoading ? "…" : dashboardSummary?.videos_processed?.toLocaleString() ?? "—",
                note: "Unique source videos",
                tone: "green",
                icon: Video,
              },
            ].map(({ label, value, note, tone, icon: Icon }) => (
              <div key={label} className="stat-card">
                <div className={`stat-icon ${tone}`}>
                  <Icon size={18} />
                </div>
                <div className="stat-info">
                  <span>{label}</span>
                  <strong>{value}</strong>
                  <small>{note}</small>
                </div>
              </div>
            ))}
          </div>

          <div className="dashboard-grid">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Live stream</h2>
                  <p>Local browser camera · no CCTV feeds configured</p>
                </div>
                <div className={`live-pill ${cameraStream ? "" : "offline-pill"}`}>
                  {cameraStream ? <i /> : null}
                  {cameraStream ? "Connected" : "Not connected"}
                </div>
              </div>

              <div className="camera-preview">
                <div className="camera-top-label">
                  <span>{cameraStream ? "Local camera feed" : "No live feed"}</span>
                  <span>{cameraStream ? "Browser camera" : "Connect a camera to start"}</span>
                </div>

                {cameraStream ? (
                  <video
                    className="camera-video"
                    autoPlay
                    muted
                    playsInline
                    ref={(video) => {
                      if (video) {
                        video.srcObject = cameraStream;
                      }
                    }}
                  />
                ) : (
                  <div className="camera-center">
                    <div className="camera-symbol">
                      <ImageIcon size={28} />
                    </div>
                    <strong>No camera connected</strong>
                    <p>Allow browser camera access to preview a local feed.</p>
                    <Activity size={22} />
                  </div>
                )}

                <div className="camera-bottom-label">
                  <span>
                    <Circle
                      size={8}
                      fill="currentColor"
                      className={cameraStream ? "text-green" : "text-muted"}
                    />
                    {cameraStream ? "Camera stream active" : "Camera stream inactive"}
                  </span>
                </div>
              </div>

              <div className="camera-footer">
                <span>
                  <Zap size={12} className={cameraStream ? "text-green" : "text-muted"} />
                  <b>{cameraStream ? "Camera connected" : "No camera connected"}</b>
                </span>
                <button
                  type="button"
                  className="text-button"
                  onClick={cameraStream ? stopCameraStream : startCameraStream}
                  disabled={cameraConnecting}
                >
                  {cameraConnecting
                    ? "Connecting..."
                    : cameraStream
                      ? "Disconnect camera"
                      : "Connect camera"}
                  <ChevronRight size={11} />
                </button>
              </div>
              {cameraError ? <div className="notice error-notice">{cameraError}</div> : null}
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Recent incidents</h2>
                  <p>{incidentPeriod === "all" ? "Latest saved detections" : "Filtered saved detections"}</p>
                </div>
              </div>

              <div className="recent-list">
                {filteredIncidents.slice(0, 5).map((incident) => (
                  <div key={incident.id} className="recent-item">
                    <div className="incident-symbol">
                      <ShieldAlert size={16} />
                    </div>
                    <div className="recent-copy">
                      <strong>{incident.class_name} · {incident.video_filename}</strong>
                      <span>
                        {incident.zone_name} · {(incident.confidence * 100).toFixed(1)}% · {formatDateTime(incident.created_at)}
                      </span>
                    </div>
                    <span className={`status ${incident.status === "Resolved" ? "status-resolved" : incident.status === "Reviewed" ? "status-review" : "status-new"}`}>
                      {incident.status || "New"}
                    </span>
                    <button
                      type="button"
                      className="small-action"
                      onClick={() => openIncidentDetails(incident)}
                    >
                      Details
                    </button>
                  </div>
                ))}
                {filteredIncidents.length === 0 ? (
                  <p className="empty-inline">
                    {incidents.length > 0
                      ? "No incidents match the selected filters."
                      : "No saved incidents yet. Analyze a video with a restricted zone to populate this list."}
                  </p>
                ) : null}
              </div>

              <button
                type="button"
                className="full-width-button"
                onClick={() => setActivePage("Incidents")}
              >
                View incidents
              </button>
            </section>
          </div>

          <div className="activity-panel panel">
            <div className="panel-heading">
              <div>
                <h2>Operational activity</h2>
                <p>Measured from saved restricted-zone detections</p>
              </div>
            </div>

            <div className="activity-grid">
              {[
                {
                  label: "Incident detections",
                  value: dashboardLoading ? "…" : dashboardSummary?.threat_alerts?.toLocaleString() ?? "—",
                  note: "Saved restricted-zone events",
                },
                {
                  label: "Source videos",
                  value: dashboardLoading ? "…" : dashboardSummary?.videos_processed?.toLocaleString() ?? "—",
                  note: "Videos with saved incidents",
                },
                {
                  label: "Frames with incidents",
                  value: dashboardLoading ? "…" : dashboardSummary?.frames_with_incidents?.toLocaleString() ?? "—",
                  note: "Unique source and frame pairs",
                },
                {
                  label: "Latest incident",
                  value: dashboardLoading
                    ? "…"
                    : !dashboardSummary?.last_incident_at
                      ? "No data"
                      : formatDateTime(dashboardSummary.last_incident_at),
                  note: "Most recent saved event",
                },
              ].map(({ label, value, note }) => (
                <div key={label} className="activity-item">
                  <div className="stat-icon blue">
                    <Activity size={16} />
                  </div>
                  <div>
                    <strong>{label}</strong>
                    <span>{value}</span>
                    <span>{note}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="dashboard-grid" style={{ marginTop: 20 }}>
            <section className="panel">
              <div className="table-toolbar">
                <div>
                  <h2>Risk by camera zone</h2>
                  <p>Saved incident counts grouped by source video and zone</p>
                </div>
                <select
                  aria-label="Zone filter"
                  value={zoneFilter}
                  onChange={(event) => {
                    setZoneFilter(event.target.value);
                    setIncidentPage(1);
                  }}
                >
                  <option>All zones</option>
                  {availableZones.map((zone) => <option key={zone}>{zone}</option>)}
                </select>
              </div>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Source video</th>
                      <th>Zone</th>
                      <th>Incidents</th>
                      <th>Latest incident</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {incidentsByZone.map((group) => (
                      <tr key={`${group.source}-${group.zone}`}>
                        <td className="mono">{group.source}</td>
                        <td>{group.zone}</td>
                        <td>{group.incident_count.toLocaleString()}</td>
                        <td>{formatDateTime(group.last_incident_at)}</td>
                        <td>
                          <button
                            type="button"
                            className="small-action"
                            onClick={() => {
                              setIncidentSearch(group.source);
                              setZoneFilter(group.zone);
                              setIncidentPage(1);
                              setActivePage("Incidents");
                            }}
                          >
                            Review
                          </button>
                        </td>
                      </tr>
                    ))}
                    {incidentsByZone.length === 0 ? (
                      <tr><td colSpan="5">No incident data matches the selected filters.</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Detector performance</h2>
                  <p>Observed incident detections; not an accuracy score</p>
                </div>
              </div>

              <div className="performance-summary">
                <div>
                  <span>Average confidence</span>
                  <strong>
                    {dashboardLoading
                      ? "…"
                      : dashboardSummary?.average_confidence == null
                        ? "No data"
                        : `${(dashboardSummary.average_confidence * 100).toFixed(1)}%`}
                  </strong>
                </div>
                <div>
                  <span>Incident samples</span>
                  <strong>
                    {dashboardLoading
                      ? "…"
                      : dashboardSummary?.threat_alerts?.toLocaleString() ?? "—"}
                  </strong>
                </div>
              </div>

              <p className="chart-caption">Saved incident detections by object class</p>
              <div className="bar-list">
                {Object.entries(dashboardSummary?.incident_class_counts || {}).map(([label, count]) => {
                  const total = dashboardSummary?.threat_alerts || 0;
                  const share = total ? (count / total) * 100 : 0;
                  return (
                  <div key={label} className="bar-row">
                    <div>
                      <span>{label}</span>
                      <strong>{count.toLocaleString()} · {share.toFixed(1)}%</strong>
                    </div>
                    <div className="bar-track">
                      <div style={{ width: `${share}%` }} />
                    </div>
                  </div>
                  );
                })}
                {!dashboardLoading && !dashboardSummary?.threat_alerts ? (
                  <p className="empty-inline">No saved detections are available for comparison.</p>
                ) : null}
              </div>

              <div className="notice">
                <Activity size={16} className="text-blue" />
                <span>
                  Confidence and class mix are calculated from saved restricted-zone incidents only. Model accuracy and processing latency are not recorded.
                </span>
              </div>
            </section>
          </div>

          <div className="dashboard-grid" style={{ marginTop: 20 }}>
            <section className="panel">
              <div className="table-toolbar">
                <div>
                  <h2>Video upload</h2>
                  <p>Send a video to the backend vision service</p>
                </div>
              </div>

              <div className="zone-preview">
                <Upload size={26} />
                <strong>Analyze video stream</strong>
                <p>Upload a .mp4, .avi, .mov, or .mkv file. The backend will run the YOLO model and return detection statistics.</p>
                <input
                  type="file"
                  accept=".mp4,.avi,.mov,.mkv"
                  onChange={(event) => {
                    setSelectedFile(event.target.files?.[0] || null);
                    setRestrictedZone(null);
                    setResults(null);
                  }}
                />
              </div>

              <label className="confidence-control" htmlFor="confidence-threshold">
                <span>
                  <strong>Confidence threshold</strong>
                  <strong>{Math.round(confidenceThreshold * 100)}%</strong>
                </span>
                <input
                  id="confidence-threshold"
                  type="range"
                  min="0.05"
                  max="0.95"
                  step="0.05"
                  value={confidenceThreshold}
                  onChange={(event) => setConfidenceThreshold(Number(event.target.value))}
                  disabled={isAnalyzing}
                />
                <small>
                  Higher values filter out less-confident detections. Applies to the next analysis.
                </small>
              </label>

              <div className="camera-footer">
                <span>
                  <Download size={12} className="text-blue" />
                  <b>{selectedFile ? selectedFile.name : "No file selected"}</b>
                </span>
                <button type="button" className="primary-button" onClick={handleAnalyze} disabled={isAnalyzing || !selectedFile}>
                  {isAnalyzing
                    ? "Analyzing..."
                    : restrictedZone
                      ? "Analyze with restricted zone"
                      : "Analyze video"}
                </button>
              </div>

              {error ? <div className="notice error-notice">{error}</div> : null}
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Detection settings</h2>
                  <p>Current settings for the next uploaded video analysis</p>
                </div>
              </div>

              <div className="settings-list">
                {[
                  {
                    name: "Detector model",
                    detail: "Model configured by the backend vision service",
                    value: "yolo26n.pt",
                  },
                  {
                    name: "Confidence threshold",
                    detail: "Applied to the next video analysis",
                    value: `${Math.round(confidenceThreshold * 100)}%`,
                  },
                  {
                    name: "Restricted zone",
                    detail: "Incidents are created only when a detection enters this zone",
                    value: restrictedZone ? "Active" : "Not configured",
                  },
                  {
                    name: "Input source",
                    detail: "Camera streams are not sent to the detector",
                    value: "Uploaded video",
                  },
                ].map(({ name, detail, value }) => (
                  <div key={name}>
                    <div>
                      <strong>{name}</strong>
                      <p>{detail}</p>
                    </div>
                    <code>{value}</code>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {results ? (
            <section className="panel results-panel">
              <h3 className="results-title">Analysis results</h3>
              <div className="camera-footer">
                <span>
                  <Gauge size={12} className="text-purple" />
                  <b>{results.filename || "Uploaded video"}</b>
                </span>
                <span className="text-green">Status: {results.status}</span>
              </div>
              {typeof results.results?.confidence_threshold === "number" ? (
                <p className="analysis-threshold">
                  Confidence used: {Math.round(results.results.confidence_threshold * 100)}%
                </p>
              ) : null}
              <div className="stats-grid" style={{ marginTop: 18 }}>
                <div className="stat-card">
                  <div className="stat-icon blue"><Activity size={18} /></div>
                  <div className="stat-info">
                    <span>Frames processed</span>
                    <strong>{results.results?.frames_processed ?? 0}</strong>
                    <small>Current run</small>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon red"><ShieldAlert size={18} /></div>
                  <div className="stat-info">
                    <span>Total detections</span>
                    <strong>{results.results?.total_detections ?? 0}</strong>
                    <small>Detected objects</small>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon purple"><UserCircle2 size={18} /></div>
                  <div className="stat-info">
                    <span>People tracked</span>
                    <strong>{results.results?.person_detections ?? 0}</strong>
                    <small>Human detections</small>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon green"><Sparkles size={18} /></div>
                  <div className="stat-info">
                    <span>Classes</span>
                    <strong>{Object.keys(results.results?.class_counts || {}).length}</strong>
                    <small>Known categories</small>
                  </div>
                </div>
              </div>
              <div className="notice">
                <span>{JSON.stringify(results.results?.class_counts || {}, null, 2)}</span>
              </div>
              {annotatedFrames.length > 0 ? (
                <section className="frame-gallery">
                  <div className="panel-heading">
                    <div>
                      <h2>Processed Frame Gallery</h2>
                      <p>Inspect annotated frames from the analyzed video.</p>
                    </div>
                    <div className="gallery-actions">
                      <span className="status status-resolved">
                        {annotatedFrames.length} frames
                      </span>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          setZoneFrame(annotatedFrames[0]);
                          setZoneDraft(restrictedZone || []);
                          setZoneEditorOpen(true);
                        }}
                      >
                        {restrictedZone ? "Edit restricted zone" : "Draw restricted zone"}
                      </button>
                    </div>
                  </div>

                  {restrictedZone ? (
                    <div className="zone-active-notice">
                      Restricted zone active. Analyze the video again to create incidents for detections inside it.
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setRestrictedZone(null)}
                      >
                        Clear zone
                      </button>
                    </div>
                  ) : null}

                  <div className="frame-grid">
                    {annotatedFrames.map((frame, index) => (
                      <button
                        type="button"
                        className="frame-card"
                        key={frame.frame ?? index}
                        onClick={() => setSelectedFrame(frame)}
                        aria-label={`View annotated video frame ${frame.frame ?? index + 1} larger`}
                      >
                        <img
                          src={frame.image}
                          alt={`Annotated video frame ${frame.frame ?? index + 1}`}
                          loading="lazy"
                        />
                        <div className="frame-caption">
                          <strong>Frame {frame.frame ?? index + 1}</strong>
                          <span>Click to enlarge</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
              <h2 className="results-title">Detected Objects</h2>
              {(results.results?.incidents || []).length > 0 ? (
                <div className="notice">
                  <ShieldAlert size={15} className="text-blue" />
                  <span>
                    {results.results.incidents.length} restricted-zone incident(s) created. Open the Incidents page to review them.
                  </span>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setActivePage("Incidents")}
                  >
                    View incidents
                    <ChevronRight size={12} />
                  </button>
                </div>
              ) : restrictedZone ? (
                <div className="notice">
                  No detections had their bottom-center point inside the restricted zone.
                </div>
              ) : null}
            </section>
          ) : null}
            </>
          ) : activePage === "Incidents" ? (
            <section className="incidents-page">
              <div className="page-heading">
                <div>
                  <h1>Incidents</h1>
                  <p>Detections whose bottom-center point fell inside a restricted zone.</p>
                </div>
                <span className="status status-new">
                  {filteredIncidents.length.toLocaleString()} of {incidents.length.toLocaleString()}
                </span>
              </div>
              {incidentLoadError ? (
                <div className="notice error-notice">{incidentLoadError}</div>
              ) : null}
              {incidentFilterControls}
              {incidentStatusError ? (
                <div className="notice error-notice">{incidentStatusError}</div>
              ) : null}
              {filteredIncidents.length > 0 ? (
                <section className="panel">
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Source video</th>
                          <th>Object class</th>
                          <th>Zone</th>
                          <th>Confidence</th>
                          <th>Created</th>
                          <th>Status</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paginatedIncidents.map((incident) => (
                          <tr key={incident.id}>
                            <td>{incident.video_filename}</td>
                            <td><span className="severity severity-high">{incident.class_name}</span></td>
                            <td>{incident.zone_name}</td>
                            <td>{(incident.confidence * 100).toFixed(1)}%</td>
                            <td>{formatDateTime(incident.created_at)}</td>
                            <td>
                              <span className={`status ${incident.status === "Resolved" ? "status-resolved" : incident.status === "Reviewed" ? "status-review" : "status-new"}`}>
                                {incident.status || "New"}
                              </span>
                            </td>
                            <td>
                              <div className="incident-actions">
                                <button
                                  type="button"
                                  className="small-action"
                                  onClick={() => openIncidentDetails(incident)}
                                >
                                  Details
                                </button>
                                <select
                                  aria-label={`Review status for ${incident.class_name} in ${incident.video_filename}`}
                                  value={incident.status || "New"}
                                  disabled={updatingIncidentIds.includes(incident.id)}
                                  onChange={(event) =>
                                    handleIncidentStatusChange(incident.id, event.target.value)
                                  }
                                >
                                  <option value="New">New</option>
                                  <option value="Reviewed">Reviewed</option>
                                  <option value="Resolved">Resolved</option>
                                </select>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="pagination">
                      <span>
                        Page {incidentPage} of {incidentPageCount} · showing {paginatedIncidents.length} rows
                      </span>
                      <div>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={incidentPage <= 1}
                          onClick={() => setIncidentPage((page) => Math.max(1, page - 1))}
                        >
                          Previous
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={incidentPage >= incidentPageCount}
                          onClick={() => setIncidentPage((page) => Math.min(incidentPageCount, page + 1))}
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              ) : (
                <section className="panel incidents-empty">
                  {incidents.length > 0 ? <Search size={30} /> : <ShieldCheck size={30} />}
                  <h2>{incidents.length > 0 ? "No matching incidents" : "No incidents yet"}</h2>
                  <p>
                    {incidents.length > 0
                      ? "Try changing the search text, time range, or zone filter."
                      : "Analyze a video, draw a restricted zone on one of its processed frames, then analyze it again with the zone enabled."}
                  </p>
                  {incidents.length === 0 ? (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => setActivePage("Overview")}
                    >
                      Go to video analysis
                    </button>
                  ) : null}
                </section>
              )}
            </section>
          ) : activePage === "Cameras" ? (
                <section className="incidents-page">
                  <div className="page-heading">
                    <div>
                      <h1>Cameras</h1>
                      <p>Connect a local browser camera preview or inspect video sources with saved detections.</p>
                    </div>
                    <span className={`live-pill ${cameraStream ? "" : "offline-pill"}`}>
                      {cameraStream ? "Local camera connected" : "No camera connected"}
                    </span>
                  </div>
                  <div className="dashboard-grid camera-page-grid">
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Local camera preview</h2>
                          <p>This browser preview is not sent to the detector.</p>
                        </div>
                      </div>
                      <div className="camera-preview">
                        {cameraStream ? (
                          <video
                            className="camera-video"
                            autoPlay
                            muted
                            playsInline
                            ref={(video) => {
                              if (video && video.srcObject !== cameraStream) {
                                video.srcObject = cameraStream;
                              }
                            }}
                          />
                        ) : (
                          <div className="camera-center">
                            <div className="camera-symbol"><ImageIcon size={28} /></div>
                            <strong>No camera connected</strong>
                            <p>Connect a camera to preview its local feed.</p>
                          </div>
                        )}
                      </div>
                      {cameraError ? <div className="notice error-notice">{cameraError}</div> : null}
                      <button
                        type="button"
                        className={cameraStream ? "danger-button camera-action" : "primary-button camera-action"}
                        onClick={cameraStream ? stopCameraStream : startCameraStream}
                        disabled={cameraConnecting}
                      >
                        {cameraConnecting
                          ? "Connecting..."
                          : cameraStream
                            ? "Disconnect camera"
                            : "Connect camera"}
                      </button>
                    </section>
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Video sources</h2>
                          <p>Videos with persisted restricted-zone detections.</p>
                        </div>
                        <span className="status status-resolved">{sourceVideoSummary.length} sources</span>
                      </div>
                      {sourceVideoSummary.length > 0 ? (
                        <div className="table-wrap">
                          <table>
                            <thead><tr><th>Source video</th><th>Incidents</th><th>Last event</th><th>Action</th></tr></thead>
                            <tbody>
                              {sourceVideoSummary.map((source) => (
                                <tr key={source.filename}>
                                  <td className="mono">{source.filename}</td>
                                  <td>{source.incident_count.toLocaleString()}</td>
                                  <td>{formatDateTime(source.last_incident_at)}</td>
                                  <td>
                                    <button
                                      type="button"
                                      className="small-action"
                                      onClick={() => {
                                        setIncidentSearch(source.filename);
                                        setIncidentPage(1);
                                        setActivePage("Incidents");
                                      }}
                                    >
                                      View incidents
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="empty-inline">No analyzed video sources have saved incidents.</p>
                      )}
                    </section>
                  </div>
                </section>
              ) : activePage === "Reports" ? (
                <section className="incidents-page">
                  <div className="page-heading">
                    <div>
                      <h1>Reports</h1>
                      <p>Review and export saved incident records. Current search, date and zone filters are included.</p>
                    </div>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={downloadReport}
                      disabled={filteredIncidents.length === 0}
                    >
                      <Download size={14} />
                      Export CSV ({filteredIncidents.length.toLocaleString()})
                    </button>
                  </div>
                  {reportMessage ? <div className="notice">{reportMessage}</div> : null}
                  {incidentLoadError ? <div className="notice error-notice">{incidentLoadError}</div> : null}
                  {incidentFilterControls}
                  <div className="stats-grid report-stats">
                    <div className="stat-card"><div className="stat-info"><span>Included incidents</span><strong>{filteredIncidents.length.toLocaleString()}</strong><small>Current filters</small></div></div>
                    <div className="stat-card"><div className="stat-info"><span>Source videos</span><strong>{new Set(filteredIncidents.map(({ video_filename }) => video_filename)).size.toLocaleString()}</strong><small>In this report</small></div></div>
                    <div className="stat-card"><div className="stat-info"><span>Zones</span><strong>{new Set(filteredIncidents.map(({ zone_name }) => zone_name)).size.toLocaleString()}</strong><small>In this report</small></div></div>
                    <div className="stat-card"><div className="stat-info"><span>Average confidence</span><strong>{filteredIncidents.length ? `${(filteredIncidents.reduce((sum, incident) => sum + incident.confidence, 0) / filteredIncidents.length * 100).toFixed(1)}%` : "—"}</strong><small>Included incidents</small></div></div>
                  </div>
                  <section className="panel">
                    <div className="panel-heading">
                      <div><h2>Detections by object class</h2><p>Computed from included incident rows</p></div>
                    </div>
                    {Object.keys(reportClassCounts).length > 0 ? (
                      <div className="table-wrap">
                        <table>
                          <thead><tr><th>Object class</th><th>Incidents</th><th>Share</th></tr></thead>
                          <tbody>
                            {Object.entries(reportClassCounts).sort((a, b) => b[1] - a[1]).map(([className, count]) => (
                              <tr key={className}><td>{className}</td><td>{count.toLocaleString()}</td><td>{(count / filteredIncidents.length * 100).toFixed(1)}%</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : <p className="empty-inline">No incidents match the selected filters.</p>}
                  </section>
                </section>
              ) : (
                <section className="incidents-page">
                  <div className="page-heading">
                    <div>
                      <h1>Settings</h1>
                      <p>Configure the detector options used for the next video analysis.</p>
                    </div>
                    <span className="status status-resolved">Saved in this browser</span>
                  </div>
                  <section className="panel settings-page-panel">
                    <div className="panel-heading">
                      <div><h2>Detection settings</h2><p>Updates are saved automatically for this browser.</p></div>
                    </div>
                    <label className="confidence-control" htmlFor="settings-confidence-threshold">
                      <span>
                        <strong>Confidence threshold</strong>
                        <strong>{Math.round(confidenceThreshold * 100)}%</strong>
                      </span>
                      <input
                        id="settings-confidence-threshold"
                        type="range"
                        min="0.05"
                        max="0.95"
                        step="0.05"
                        value={confidenceThreshold}
                        onChange={(event) => setConfidenceThreshold(Number(event.target.value))}
                        disabled={isAnalyzing}
                      />
                      <small>Higher values filter out lower-confidence detections. Applies to the next uploaded video analysis.</small>
                    </label>
                    <div className="settings-list">
                      <div><div><strong>Detector model</strong><p>Model loaded by the backend vision service.</p></div><code>yolo26n.pt</code></div>
                      <div><div><strong>Restricted zone</strong><p>Clear or change the zone from the analysis results.</p></div><code>{restrictedZone ? `${restrictedZone.length} points` : "Not configured"}</code></div>
                      <div><div><strong>Backend status</strong><p>Health endpoint check.</p></div><code>{backendStatus.label}</code></div>
                      <div><div><strong>Browser camera</strong><p>Preview only; camera is not used for video analysis.</p></div><code>{cameraStream ? "Connected" : "Disconnected"}</code></div>
                    </div>
                    <div className="settings-actions">
                      {restrictedZone ? (
                        <button type="button" className="danger-button" onClick={() => setRestrictedZone(null)}>
                          Clear restricted zone
                        </button>
                      ) : null}
                      <button type="button" className="secondary-button" onClick={() => setConfidenceThreshold(0.4)}>
                        Reset threshold to 40%
                      </button>
                      <button type="button" className="secondary-button" onClick={refreshDashboardData} disabled={isRefreshing}>
                        Check backend now
                      </button>
                    </div>
                  </section>
                </section>
          )}
        </div>

        <footer className="app-footer">
          <span>VisionGuard control plane</span>
          <span>Incident data stored locally</span>
        </footer>
      </main>
      {selectedIncident ? (
        <div
          className="frame-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedIncident(null);
            }
          }}
        >
          <section
            className="frame-modal incident-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="incident-detail-title"
          >
            <div className="frame-modal-heading">
              <div>
                <h2 id="incident-detail-title">Incident details</h2>
                <p>{selectedIncident.video_filename} · frame {selectedIncident.frame}</p>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setSelectedIncident(null)}
                aria-label="Close incident details"
              >
                <X size={16} />
              </button>
            </div>
            <dl className="incident-detail-grid">
              <div><dt>Source video</dt><dd>{selectedIncident.video_filename}</dd></div>
              <div><dt>Object class</dt><dd>{selectedIncident.class_name}</dd></div>
              <div><dt>Confidence</dt><dd>{(selectedIncident.confidence * 100).toFixed(1)}%</dd></div>
              <div><dt>Timestamp</dt><dd>{formatDateTime(selectedIncident.created_at)}</dd></div>
              <div><dt>Restricted zone</dt><dd>{selectedIncident.zone_name}</dd></div>
              <div><dt>Review status</dt><dd>{selectedIncident.status || "New"}</dd></div>
            </dl>
            <div className="incident-evidence">
              <h3>Annotated evidence · frame {selectedIncident.frame}</h3>
              {incidentEvidenceLoading ? <p>Loading annotated frame…</p> : null}
              {incidentEvidenceError ? (
                <div className="notice error-notice">{incidentEvidenceError}</div>
              ) : null}
              {incidentEvidenceUrl ? (
                <img
                  src={incidentEvidenceUrl}
                  alt={`Annotated evidence for ${selectedIncident.class_name} detection in frame ${selectedIncident.frame}`}
                />
              ) : null}
              {!incidentEvidenceUrl && !incidentEvidenceLoading ? (
                <label className="evidence-recovery">
                  <span>
                    Select the original video to regenerate the annotated frame.
                    The filename must match <strong>{selectedIncident.video_filename}</strong>.
                  </span>
                  <input
                    type="file"
                    accept=".mp4,.avi,.mov,.mkv"
                    onChange={handleRecoverIncidentEvidence}
                    disabled={recoveringIncidentEvidence}
                  />
                </label>
              ) : null}
              {recoveringIncidentEvidence ? <p>Regenerating evidence for frame {selectedIncident.frame}…</p> : null}
            </div>
            <div className="incident-detail-actions">
              <label>
                Review status
                <select
                  value={selectedIncident.status || "New"}
                  disabled={updatingIncidentIds.includes(selectedIncident.id)}
                  onChange={(event) =>
                    handleIncidentStatusChange(selectedIncident.id, event.target.value)
                  }
                >
                  <option value="New">New</option>
                  <option value="Reviewed">Reviewed</option>
                  <option value="Resolved">Resolved</option>
                </select>
              </label>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setSelectedIncident(null)}
              >
                Close
              </button>
            </div>
            {incidentStatusError ? (
              <div className="notice error-notice">{incidentStatusError}</div>
            ) : null}
          </section>
        </div>
      ) : null}
      {selectedFrame ? (
        <div
          className="frame-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedFrame(null);
            }
          }}
        >
          <section
            className="frame-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="frame-modal-title"
          >
            <div className="frame-modal-heading">
              <div>
                <h2 id="frame-modal-title">
                  Frame {selectedFrame.frame ?? "preview"}
                </h2>
                <p>YOLO annotated detection preview</p>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setSelectedFrame(null)}
                aria-label="Close enlarged frame"
              >
                <X size={16} />
              </button>
            </div>
            <img
              src={selectedFrame.image}
              alt={`Enlarged annotated video frame ${selectedFrame.frame ?? ""}`}
            />
          </section>
        </div>
      ) : null}
      {zoneEditorOpen && zoneFrame ? (
        <div
          className="frame-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setZoneEditorOpen(false);
            }
          }}
        >
          <section
            className="frame-modal zone-editor-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="zone-editor-title"
          >
            <div className="frame-modal-heading">
              <div>
                <h2 id="zone-editor-title">Draw restricted zone</h2>
                <p>Click at least three points on the frame to outline the restricted area.</p>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setZoneEditorOpen(false)}
                aria-label="Close zone editor"
              >
                <X size={16} />
              </button>
            </div>
            <div
              className="zone-drawing-stage"
              onClick={(event) => {
                const bounds = event.currentTarget
                  .querySelector("img")
                  .getBoundingClientRect();
                const x = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
                const y = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
                setZoneDraft((points) => points.length < 100 ? [...points, [x, y]] : points);
              }}
            >
              <img src={zoneFrame.image} alt={`Frame ${zoneFrame.frame} for zone drawing`} />
              <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
                {zoneDraft.length >= 3 ? (
                  <polygon
                    points={zoneDraft.map(([x, y]) => `${x * 1000},${y * 1000}`).join(" ")}
                  />
                ) : null}
                {zoneDraft.length > 0 ? (
                  <polyline
                    points={zoneDraft.map(([x, y]) => `${x * 1000},${y * 1000}`).join(" ")}
                  />
                ) : null}
                {zoneDraft.map(([x, y], index) => (
                  <circle key={index} cx={x * 1000} cy={y * 1000} r="9" />
                ))}
              </svg>
            </div>
            <div className="zone-editor-footer">
              <span>{zoneDraft.length} points · at least 3 required</span>
              <div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setZoneDraft([])}
                >
                  Clear points
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={zoneDraft.length < 3}
                  onClick={() => {
                    setRestrictedZone(zoneDraft);
                    setZoneEditorOpen(false);
                  }}
                >
                  Use this zone
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export default App;
