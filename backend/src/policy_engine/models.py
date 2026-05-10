import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class AttendancePolicy(Base):
    __tablename__ = "attendance_policies"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    policy_group_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    shift_type: Mapped[str] = mapped_column(String(20), nullable=False, default="general")
    shift_start: Mapped[str] = mapped_column(String(8), nullable=False, default="09:00")

    late_grace_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=15)
    half_day_hours: Mapped[float] = mapped_column(Float, nullable=False, default=4.0)
    full_day_hours: Mapped[float] = mapped_column(Float, nullable=False, default=8.0)
    absent_cutoff_hour: Mapped[int] = mapped_column(Integer, nullable=False, default=10)

    weekend_allowed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    weekend_days: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    holiday_calendar_key: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    effective_from: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    created_by: Mapped[str] = mapped_column(String(80), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    __table_args__ = (
        Index("ix_policy_group_version", "policy_group_id", "version", unique=True),
        Index("ix_policy_effective_active", "effective_from", "is_active"),
    )


class PolicyAssignment(Base):
    __tablename__ = "policy_assignments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    policy_id: Mapped[str] = mapped_column(String(36), ForeignKey("attendance_policies.id", ondelete="CASCADE"), nullable=False)

    scope_type: Mapped[str] = mapped_column(String(20), nullable=False)
    scope_value: Mapped[str] = mapped_column(Text, nullable=False, default="*")
    effective_from: Mapped[datetime.date] = mapped_column(Date, nullable=False)

    created_by: Mapped[str] = mapped_column(String(80), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)

    __table_args__ = (
        Index("ix_assignment_scope_date", "scope_type", "scope_value", "effective_from"),
        Index("ix_assignment_policy", "policy_id"),
    )
