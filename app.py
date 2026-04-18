import os
from flask import Flask, render_template, send_from_directory
from flask_socketio import SocketIO
from config import Config
from models import db

app = Flask(__name__, template_folder='templates', static_folder='static')
app.config.from_object(Config())

db.init_app(app)

redis_url = app.config.get('REDIS_URL', '')
if redis_url:
    socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet',
                        message_queue=redis_url, max_http_buffer_size=10*1024*1024,
                        ping_timeout=60, ping_interval=25)
else:
    socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet',
                        max_http_buffer_size=10*1024*1024, ping_timeout=60, ping_interval=25)

# Register blueprints
from routes.auth import auth_bp
from routes.rooms import rooms_bp
from routes.recordings import recordings_bp
app.register_blueprint(auth_bp)
app.register_blueprint(rooms_bp)
app.register_blueprint(recordings_bp)

# Register socket handlers
from sockets.connection import register_connection_handlers
from sockets.chat import register_chat_handlers
from sockets.calls import register_call_handlers
from sockets.host_controls import register_host_handlers
register_connection_handlers(socketio)
register_chat_handlers(socketio)
register_call_handlers(socketio)
register_host_handlers(socketio)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/health')
def health():
    return {'status': 'ok'}

# Serve recordings
@app.route('/recordings/<path:filename>')
def serve_recording(filename):
    return send_from_directory(Config.UPLOAD_FOLDER, filename)

with app.app_context():
    db.create_all()
    os.makedirs(Config.UPLOAD_FOLDER, exist_ok=True)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port, debug=False)