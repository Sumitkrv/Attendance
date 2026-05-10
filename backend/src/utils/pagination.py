# ==========================================================================
# Item 9: Server-side pagination utility
# Provides consistent pagination for all list endpoints.
# ==========================================================================
import math
from flask import request


def paginate_query(query_result, default_per_page: int = 50, max_per_page: int = 200):
    """
    Paginate a list of results based on query parameters.
    
    Query params: ?page=1&per_page=50
    
    Returns:
        dict with keys: items, total, page, per_page, total_pages, has_next, has_prev
    """
    # Parse pagination params
    try:
        page = max(1, int(request.args.get("page", 1)))
    except (TypeError, ValueError):
        page = 1

    try:
        per_page = max(1, min(max_per_page, int(request.args.get("per_page", default_per_page))))
    except (TypeError, ValueError):
        per_page = default_per_page

    # If query_result is a list, paginate in-memory
    if isinstance(query_result, list):
        total = len(query_result)
        total_pages = max(1, math.ceil(total / per_page))
        page = min(page, total_pages)
        start = (page - 1) * per_page
        end = start + per_page
        items = query_result[start:end]
    else:
        # Assume it's a PyMongo cursor — clone and count
        items = list(query_result)
        total = len(items)
        total_pages = max(1, math.ceil(total / per_page))
        page = min(page, total_pages)
        start = (page - 1) * per_page
        end = start + per_page
        items = items[start:end]

    return {
        "items": items,
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": total_pages,
        "has_next": page < total_pages,
        "has_prev": page > 1,
    }


def paginate_mongo_cursor(collection, query: dict, sort=None, projection=None,
                          default_per_page: int = 50, max_per_page: int = 200,
                          serializer=None):
    """
    Paginate a MongoDB query directly (efficient — uses skip/limit).
    
    Args:
        collection: PyMongo collection
        query: MongoDB query dict
        sort: List of (field, direction) tuples
        projection: Fields to include/exclude
        default_per_page: Default items per page
        max_per_page: Maximum items per page
        serializer: Optional function to transform each document
    
    Returns:
        dict with paginated results
    """
    try:
        page = max(1, int(request.args.get("page", 1)))
    except (TypeError, ValueError):
        page = 1

    try:
        per_page = max(1, min(max_per_page, int(request.args.get("per_page", default_per_page))))
    except (TypeError, ValueError):
        per_page = default_per_page

    total = collection.count_documents(query)
    total_pages = max(1, math.ceil(total / per_page))
    page = min(page, total_pages)
    skip = (page - 1) * per_page

    cursor = collection.find(query, projection)
    if sort:
        cursor = cursor.sort(sort)
    cursor = cursor.skip(skip).limit(per_page)

    items = list(cursor)
    if serializer:
        items = [serializer(doc) for doc in items]

    return {
        "items": items,
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": total_pages,
        "has_next": page < total_pages,
        "has_prev": page > 1,
    }
