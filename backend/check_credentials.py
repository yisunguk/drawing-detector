"""
Test script to verify Azure DI credentials
Run this locally or deploy to check credential loading
"""
from app.core.config import settings
from app.services.azure_di import azure_di_service

print("=" * 50)
print("CREDENTIAL CHECK")
print("=" * 50)

print(f"\nAZURE_DOC_INTEL_ENDPOINT: {settings.AZURE_DOC_INTEL_ENDPOINT}")
print(f"AZURE_DOC_INTEL_KEY: {'*' * 10}{settings.AZURE_DOC_INTEL_KEY[-10:] if settings.AZURE_DOC_INTEL_KEY else 'NOT SET'}")

print(f"\nAZURE_FORM_RECOGNIZER_ENDPOINT: {settings.AZURE_FORM_RECOGNIZER_ENDPOINT}")
print(f"AZURE_FORM_RECOGNIZER_KEY: {'*' * 10}{settings.AZURE_FORM_RECOGNIZER_KEY[-10:] if settings.AZURE_FORM_RECOGNIZER_KEY else 'NOT SET'}")

print(f"\nazure_di_service.endpoint: {azure_di_service.endpoint}")
print(f"azure_di_service.key: {'*' * 10}{azure_di_service.key[-10:] if azure_di_service.key else 'NOT SET'}")
print(f"azure_di_service.client: {azure_di_service.client}")

print("\n" + "=" * 50)
