
import json
import math
import os
import shutil
import tempfile

from pathlib import Path
from typing import Literal
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.app.services.incident_service import (
    EVIDENCE_DIRECTORY,
    get_incident,
    get_incident_evidence_path,
    get_dashboard_summary,
    list_incidents,
    record_incidents,
    update_incident_evidence,
    update_incident_status,
)
from backend.app.services.vision_service import (
    analyze_video,
    regenerate_incident_evidence,
)

router = APIRouter(prefix="/api", tags=["Computer Vision"])

ALLOWED_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv"}


class IncidentStatusUpdate(BaseModel):
    status: Literal["New", "Reviewed", "Resolved"]


@router.get("/dashboard")
def get_dashboard():
    return {"summary": get_dashboard_summary()}


@router.get("/incidents")
def get_incidents():
    return {"incidents": list_incidents()}


@router.patch("/incidents/{incident_id}/status")
def patch_incident_status(incident_id: str, update: IncidentStatusUpdate):
    incident = update_incident_status(incident_id, update.status)
    if incident is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    return {"incident": incident}


@router.get("/incidents/{incident_id}/evidence")
def get_incident_evidence(incident_id: str):
    evidence_path = get_incident_evidence_path(incident_id)
    if evidence_path is None or not evidence_path.is_file():
        raise HTTPException(
            status_code=404,
            detail="Annotated evidence is not available for this incident",
        )
    return FileResponse(
        evidence_path,
        media_type="image/jpeg",
        filename=evidence_path.name,
    )


@router.post("/incidents/{incident_id}/evidence/recover")
def recover_incident_evidence(
    incident_id: str,
    file: UploadFile = File(...),
):
    incident = get_incident(incident_id)
    if incident is None:
        raise HTTPException(status_code=404, detail="Incident not found")

    filename = Path(file.filename or "").name
    if filename != incident["video_filename"]:
        raise HTTPException(
            status_code=400,
            detail="Select the original source video for this incident",
        )

    extension = Path(filename).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported video format",
        )

    temp_path = None
    evidence_path = None
    try:
        with tempfile.NamedTemporaryFile(
            suffix=extension,
            delete=False,
        ) as temp_file:
            temp_path = temp_file.name
            shutil.copyfileobj(file.file, temp_file)

        evidence_filename = regenerate_incident_evidence(
            temp_path,
            incident,
        )
        evidence_path = EVIDENCE_DIRECTORY / evidence_filename
        update_incident_evidence(incident_id, evidence_filename)
        return FileResponse(
            evidence_path,
            media_type="image/jpeg",
            filename=evidence_path.name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to regenerate incident evidence: {exc}",
        ) from exc
    finally:
        file.file.close()
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


@router.post("/videos/analyze")
def analyze_uploaded_video(
    file: UploadFile = File(...),
    confidence_threshold: float = Form(0.4, ge=0.05, le=0.95),
    restricted_zone: str | None = Form(None),
):
    extension = Path(file.filename or "").suffix.lower()

    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported video format"
        )

    temp_path = None

    try:
        zone_points = None
        if restricted_zone:
            try:
                zone_points = json.loads(restricted_zone)
            except json.JSONDecodeError as exc:
                raise HTTPException(
                    status_code=400,
                    detail="Restricted zone must be valid JSON",
                ) from exc

            if (
                not isinstance(zone_points, list)
                or not 3 <= len(zone_points) <= 100
                or any(
                    not isinstance(point, list)
                    or len(point) != 2
                    or any(
                        isinstance(value, bool)
                        or not isinstance(value, (int, float))
                        or not math.isfinite(value)
                        or not 0 <= value <= 1
                        for value in point
                    )
                    for point in zone_points
                )
            ):
                raise HTTPException(
                    status_code=400,
                    detail="Restricted zone must contain 3 to 100 normalized points",
                )

        with tempfile.NamedTemporaryFile(
            suffix=extension,
            delete=False
        ) as temp_file:
            temp_path = temp_file.name
            shutil.copyfileobj(file.file, temp_file)

        result = analyze_video(
            temp_path,
            confidence_threshold,
            zone_points,
        )
        result["incidents"] = record_incidents(
            file.filename or "Uploaded video",
            result["incidents"],
        )

        return {
            "status": "success",
            "filename": file.filename,
            "results": result
        }

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Video processing failed: {exc}"
        )

    finally:
        file.file.close()

        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
