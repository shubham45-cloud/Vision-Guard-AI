import sqlite3
from contextlib import closing
from pathlib import Path


DATABASE_PATH = Path(__file__).resolve().parents[2] / "storage" / "incidents.sqlite3"
EVIDENCE_DIRECTORY = Path(__file__).resolve().parents[2] / "evidence" / "incidents"


def _connect() -> sqlite3.Connection:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS incidents (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            video_filename TEXT NOT NULL,
            frame INTEGER NOT NULL,
            class_name TEXT NOT NULL,
            confidence REAL NOT NULL,
            point_x REAL NOT NULL,
            point_y REAL NOT NULL,
            zone_name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'New',
            evidence_filename TEXT
        )
        """
    )
    columns = {
        row["name"]
        for row in connection.execute("PRAGMA table_info(incidents)").fetchall()
    }
    if "status" not in columns:
        connection.execute(
            "ALTER TABLE incidents ADD COLUMN status TEXT NOT NULL DEFAULT 'New'"
        )
    if "evidence_filename" not in columns:
        connection.execute(
            "ALTER TABLE incidents ADD COLUMN evidence_filename TEXT"
        )
    connection.commit()
    return connection


def record_incidents(
    video_filename: str,
    incidents: list[dict],
) -> list[dict]:
    if not incidents:
        return []

    with closing(_connect()) as connection:
        with connection:
            connection.executemany(
                """
                INSERT INTO incidents (
                    id, created_at, video_filename, frame, class_name,
                    confidence, point_x, point_y, zone_name, status,
                    evidence_filename
                ) VALUES (
                    :id, :created_at, :video_filename, :frame, :class_name,
                    :confidence, :point_x, :point_y, :zone_name, :status,
                    :evidence_filename
                )
                """,
                [
                    {
                        **incident,
                        "video_filename": video_filename,
                        "status": incident.get("status", "New"),
                        "evidence_filename": incident.get("evidence_filename"),
                    }
                    for incident in incidents
                ],
            )

    return [
        {
            **incident,
            "video_filename": video_filename,
            "status": incident.get("status", "New"),
        }
        for incident in incidents
    ]


def get_dashboard_summary() -> dict:
    with closing(_connect()) as connection:
        summary = connection.execute(
            """
            SELECT
                COUNT(*) AS total_incidents,
                SUM(CASE WHEN class_name = 'person' THEN 1 ELSE 0 END) AS people_tracked,
                COUNT(DISTINCT video_filename) AS videos_processed,
                AVG(confidence) AS average_confidence,
                MAX(created_at) AS last_incident_at
            FROM incidents
            """
        ).fetchone()
        frames_with_incidents = connection.execute(
            """
            SELECT COUNT(*)
            FROM (
                SELECT DISTINCT video_filename, frame
                FROM incidents
            )
            """
        ).fetchone()[0]
        class_rows = connection.execute(
            """
            SELECT class_name, COUNT(*) AS incident_count
            FROM incidents
            GROUP BY class_name
            ORDER BY incident_count DESC, class_name
            """
        ).fetchall()

    total_incidents = int(summary["total_incidents"] or 0)
    people_tracked = int(summary["people_tracked"] or 0)
    videos_processed = int(summary["videos_processed"] or 0)
    class_counts = {
        row["class_name"]: int(row["incident_count"])
        for row in class_rows
    }

    return {
        "frames_with_incidents": int(frames_with_incidents or 0),
        "threat_alerts": total_incidents,
        "people_tracked": people_tracked,
        "videos_processed": videos_processed,
        "average_confidence": (
            float(summary["average_confidence"])
            if summary["average_confidence"] is not None
            else None
        ),
        "last_incident_at": summary["last_incident_at"],
        "incident_class_counts": class_counts,
    }


def list_incidents() -> list[dict]:
    with closing(_connect()) as connection:
        rows = connection.execute(
            """
            SELECT id, created_at, video_filename, frame, class_name,
                   confidence, point_x, point_y, zone_name, status,
                   evidence_filename
            FROM incidents
            ORDER BY created_at DESC
            """
        ).fetchall()

    return [dict(row) for row in rows]


def update_incident_status(incident_id: str, status: str) -> dict | None:
    with closing(_connect()) as connection:
        with connection:
            cursor = connection.execute(
                "UPDATE incidents SET status = ? WHERE id = ?",
                (status, incident_id),
            )
            if cursor.rowcount == 0:
                return None
            row = connection.execute(
                """
                SELECT id, created_at, video_filename, frame, class_name,
                       confidence, point_x, point_y, zone_name, status,
                       evidence_filename
                FROM incidents
                WHERE id = ?
                """,
                (incident_id,),
            ).fetchone()

    return dict(row)


def get_incident_evidence_path(incident_id: str) -> Path | None:
    with closing(_connect()) as connection:
        row = connection.execute(
            "SELECT evidence_filename FROM incidents WHERE id = ?",
            (incident_id,),
        ).fetchone()

    if row is None or not row["evidence_filename"]:
        return None

    filename = Path(row["evidence_filename"])
    if filename.name != str(filename) or filename.suffix.lower() != ".jpg":
        return None

    return EVIDENCE_DIRECTORY / filename


def get_incident(incident_id: str) -> dict | None:
    with closing(_connect()) as connection:
        row = connection.execute(
            """
            SELECT id, created_at, video_filename, frame, class_name,
                   confidence, point_x, point_y, zone_name, status,
                   evidence_filename
            FROM incidents
            WHERE id = ?
            """,
            (incident_id,),
        ).fetchone()

    return dict(row) if row else None


def update_incident_evidence(incident_id: str, evidence_filename: str) -> None:
    with closing(_connect()) as connection:
        with connection:
            cursor = connection.execute(
                "UPDATE incidents SET evidence_filename = ? WHERE id = ?",
                (evidence_filename, incident_id),
            )
            if cursor.rowcount == 0:
                raise ValueError("Incident not found")
