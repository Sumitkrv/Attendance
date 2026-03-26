from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    PROJECT_NAME: str = "Attendance API"
    VERSION: str = "1.0.0"
    API_V1_PREFIX: str = "/api/v1"

    CORS_ORIGINS: List[str] = ["*"]

    OFFICE_LAT: float = 28.6139
    OFFICE_LON: float = 77.2090
    OFFICE_RADIUS_METERS: int = 300


settings = Settings()
