
from ultralytics import YOLO
import cv2
import base64
import numpy as np
import uuid
from datetime import datetime, timezone
from pathlib import Path
import uuid

from backend.app.services.incident_service import EVIDENCE_DIRECTORY

# Load the model once when the service is imported.
model = YOLO("yolo26n.pt")


def regenerate_incident_evidence(video_path: str, incident: dict) -> str:
    frame_number = int(incident["frame"])
    if frame_number < 1:
        raise ValueError("Incident frame number is invalid")

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError("Could not open source video")

    try:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_number - 1)
        success, frame = cap.read()
        if not success:
            raise ValueError(
                f"Source video does not contain frame {frame_number}"
            )

        prediction = model.predict(
            source=frame,
            conf=0.05,
            verbose=False,
        )[0]
        annotated_frame = prediction.plot()
        encoded, buffer = cv2.imencode(
            ".jpg",
            annotated_frame,
            [cv2.IMWRITE_JPEG_QUALITY, 85],
        )
        if not encoded:
            raise ValueError("Could not encode annotated evidence frame")

        evidence_filename = f"{uuid.uuid4()}.jpg"
        EVIDENCE_DIRECTORY.mkdir(parents=True, exist_ok=True)
        (EVIDENCE_DIRECTORY / evidence_filename).write_bytes(buffer.tobytes())
        return evidence_filename
    finally:
        cap.release()


def analyze_video(
    video_path: str,
    confidence_threshold: float = 0.4,
    restricted_zone: list[list[float]] | None = None,
) -> dict:
    cap = cv2.VideoCapture(video_path)

    if not cap.isOpened():
        raise ValueError("Could not open video file")

    frames_processed = 0
    total_detections = 0
    person_detections = 0
    class_counts = {}
    annotated_frames = []
    incidents = []

    try:
        while True:
            success, frame = cap.read()

            if not success:
                break

            frames_processed += 1
            frame_height, frame_width = frame.shape[:2]

            results = model.predict(
                source=frame,
                conf=confidence_threshold,
                verbose=False
            )

            zone_contour = None
            if restricted_zone:
                zone_contour = np.array(
                    [
                        (x * frame_width, y * frame_height)
                        for x, y in restricted_zone
                    ],
                    dtype=np.float32,
                ).reshape((-1, 1, 2))

            frame_incidents = []
            for box in results[0].boxes:
                class_id = int(box.cls[0])
                class_name = model.names[class_id]

                total_detections += 1

                class_counts[class_name] = (
                    class_counts.get(class_name, 0) + 1
                )

                if class_name == "person":
                    person_detections += 1

                if zone_contour is not None:
                    x1, y1, x2, y2 = (
                        float(value) for value in box.xyxy[0].tolist()
                    )
                    foot_x = (x1 + x2) / 2
                    foot_y = y2

                    if cv2.pointPolygonTest(
                        zone_contour,
                        (foot_x, foot_y),
                        False,
                    ) >= 0:
                        frame_incidents.append({
                            "id": str(uuid.uuid4()),
                            "created_at": datetime.now(timezone.utc).isoformat(),
                            "frame": frames_processed,
                            "class_name": class_name,
                            "confidence": float(box.conf[0]),
                            "point_x": foot_x / frame_width,
                            "point_y": foot_y / frame_height,
                            "zone_name": "Restricted Zone",
                        })

            incidents.extend(frame_incidents)
            if len(annotated_frames) < 5 or frame_incidents:
                plotted_frame = results[0].plot()
                if zone_contour is not None:
                    zone_points = np.round(zone_contour).astype(np.int32)
                    overlay = plotted_frame.copy()
                    cv2.fillPoly(overlay, [zone_points], (50, 40, 170))
                    cv2.addWeighted(
                        overlay,
                        0.2,
                        plotted_frame,
                        0.8,
                        0,
                        plotted_frame,
                    )
                    cv2.polylines(
                        plotted_frame,
                        [zone_points],
                        isClosed=True,
                        color=(80, 100, 255),
                        thickness=2,
                    )
                encoded_ok, buffer = cv2.imencode(
                    ".jpg",
                    plotted_frame,
                    [cv2.IMWRITE_JPEG_QUALITY, 75],
                )

                if frame_incidents:
                    if not encoded_ok:
                        raise ValueError(
                            f"Could not encode evidence for frame {frames_processed}"
                        )
                    evidence_filename = f"{frame_incidents[0]['id']}.jpg"
                    EVIDENCE_DIRECTORY.mkdir(parents=True, exist_ok=True)
                    evidence_path = EVIDENCE_DIRECTORY / evidence_filename
                    evidence_path.write_bytes(buffer.tobytes())
                    for incident in frame_incidents:
                        incident["evidence_filename"] = evidence_filename

                if len(annotated_frames) < 5 and encoded_ok:
                    image_base64 = base64.b64encode(
                        buffer.tobytes()
                    ).decode("utf-8")

                    annotated_frames.append({
                        "frame": frames_processed,
                        "image": f"data:image/jpeg;base64,{image_base64}",
                    })

    finally:
        cap.release()

    return {
        "frames_processed": frames_processed,
        "total_detections": total_detections,
        "person_detections": person_detections,
        "class_counts": class_counts,
        "annotated_frames": annotated_frames,
        "confidence_threshold": confidence_threshold,
        "incidents": incidents,
    }
