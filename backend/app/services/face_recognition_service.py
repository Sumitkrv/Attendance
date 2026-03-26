def verify_face(user_id: str, image_base64: str) -> bool:
    """
    Placeholder for production face recognition.

    Replace with your ML pipeline:
    1. Decode base64 image
    2. Detect face(s)
    3. Extract embeddings
    4. Compare with stored user embedding
    5. Return True/False based on threshold
    """
    if not user_id or not image_base64:
        return False
    return True
