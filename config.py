import os

class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY', 'nexusnet-secret-key-2025')
    SQLALCHEMY_DATABASE_URI = os.environ.get('DATABASE_URL', 'sqlite:///nexusnet.db')
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    REDIS_URL = os.environ.get('REDIS_URL', '')
    JWT_SECRET = os.environ.get('JWT_SECRET', 'jwt-secret-key-2025')
    JWT_EXPIRY = 86400
    UPLOAD_FOLDER = os.environ.get('UPLOAD_FOLDER', 'recordings')
    MAX_CONTENT_LENGTH = 50 * 1024 * 1024

    def __init__(self):
        if self.SQLALCHEMY_DATABASE_URI and self.SQLALCHEMY_DATABASE_URI.startswith('postgres://'):
            self.SQLALCHEMY_DATABASE_URI = self.SQLALCHEMY_DATABASE_URI.replace('postgres://', 'postgresql://', 1)
