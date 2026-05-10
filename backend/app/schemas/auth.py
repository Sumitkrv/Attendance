from typing import Any, Dict, Optional

from pydantic import BaseModel, EmailStr, model_validator


class LoginRequest(BaseModel):
    email: Optional[EmailStr] = None
    username: Optional[str] = None
    login_id: Optional[str] = None
    password: str

    @model_validator(mode="after")
    def validate_identifier(self):
        if not self.email and not self.username and not self.login_id:
            raise ValueError("email or username is required")
        return self


class LoginResponse(BaseModel):
    success: bool
    message: str
    data: Dict[str, Any]
