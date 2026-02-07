"""
Firebase Admin SDK initialization for token verification.

This module initializes Firebase Admin and provides utilities
for verifying Firebase ID tokens sent from the frontend.
"""

import os
import logging
from typing import Dict, Optional
import firebase_admin
from firebase_admin import credentials, auth

logger = logging.getLogger(__name__)

# Initialize Firebase Admin (singleton pattern)
_firebase_app = None

def initialize_firebase():
    """Initialize Firebase Admin SDK with service account credentials"""
    global _firebase_app
    
    if _firebase_app is not None:
        return _firebase_app
    
    try:
        # Try environment variable first (for Cloud Run secrets)
        service_account_json = os.getenv('FIREBASE_SERVICE_ACCOUNT_JSON')
        
        if service_account_json:
            # Parse JSON from environment variable
            import json
            service_account_dict = json.loads(service_account_json)
            cred = credentials.Certificate(service_account_dict)
        else:
            # Fallback to file path (for local development)
            service_account_path = os.getenv(
                'FIREBASE_SERVICE_ACCOUNT_PATH',
                'firebase-service-account.json'
            )
            
            if not os.path.exists(service_account_path):
                logger.warning(
                    f"Firebase service account file not found: {service_account_path}. "
                    "Token verification will not work."
                )
                return None
            
            cred = credentials.Certificate(service_account_path)
        
        _firebase_app = firebase_admin.initialize_app(cred)
        logger.info("✅ Firebase Admin SDK initialized successfully")
        return _firebase_app
        
    except Exception as e:
        logger.error(f"Failed to initialize Firebase Admin SDK: {e}")
        return None


def verify_id_token(id_token: str) -> Dict:
    """
    Verify Firebase ID token and return decoded claims.
    
    Args:
        id_token: Firebase ID token from frontend
        
    Returns:
        Decoded token claims containing user info
        
    Raises:
        ValueError: If token is invalid or verification fails
    """
    if _firebase_app is None:
        initialize_firebase()
    
    if _firebase_app is None:
        raise ValueError("Firebase Admin SDK is not initialized")
    
    try:
        decoded_token = auth.verify_id_token(id_token)
        return decoded_token
    except auth.InvalidIdTokenError:
        raise ValueError("Invalid ID token")
    except auth.ExpiredIdTokenError:
        raise ValueError("Token has expired")
    except auth.RevokedIdTokenError:
        raise ValueError("Token has been revoked")
    except Exception as e:
        raise ValueError(f"Token verification failed: {str(e)}")


# Initialize on module import
initialize_firebase()
