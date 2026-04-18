from flask import Blueprint, request, jsonify, send_file
import os, time
from models import db, Recording, Room
from routes.auth import verify_token
from config import Config

recordings_bp = Blueprint('recordings', __name__)

def _uid():
    ah = request.headers.get('Authorization', '')
    if not ah.startswith('Bearer '):
        return None
    p = verify_token(ah.split(' ')[1])
    return p.get('user_id') if p else None

@recordings_bp.route('/api/recordings/<room_code>')
def list_recs(room_code):
    if not _uid():
        return jsonify({'error': 'Auth required'}), 401
    room = Room.query.filter_by(code=room_code).first()
    if not room:
        return jsonify({'error': 'Not found'}), 404
    recs = Recording.query.filter_by(room_id=room.id).order_by(Recording.created_at.desc()).all()
    return jsonify({'recordings': [r.to_dict() for r in recs]})

@recordings_bp.route('/api/recordings/<int:rid>/download')
def download_rec(rid):
    if not _uid():
        return jsonify({'error': 'Auth required'}), 401
    rec = Recording.query.get(rid)
    if not rec or not os.path.exists(rec.filepath):
        return jsonify({'error': 'Not found'}), 404
    return send_file(rec.filepath, as_attachment=True, download_name=rec.filename)

@recordings_bp.route('/api/recordings/upload', methods=['POST'])
def upload_rec():
    uid = _uid()
    if not uid:
        return jsonify({'error': 'Auth required'}), 401
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    f = request.files['file']
    rc = request.form.get('room_code', '')
    room = Room.query.filter_by(code=rc).first()
    if not room:
        return jsonify({'error': 'Room not found'}), 404
    os.makedirs(Config.UPLOAD_FOLDER, exist_ok=True)
    fn = f"rec_{rc}_{int(time.time())}.webm"
    fp = os.path.join(Config.UPLOAD_FOLDER, fn)
    f.save(fp)
    dur = 0
    try:
        import subprocess
        r = subprocess.run(['ffprobe','-v','quiet','-show_entries','format=duration',
                           '-of','default=noprint_wrappers=1:nokey=1', fp],
                          capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            dur = float(r.stdout.strip())
    except:
        pass
    rec = Recording(room_id=room.id, user_id=uid, filename=fn, filepath=fp,
                    duration=dur, file_size=os.path.getsize(fp))
    db.session.add(rec)
    db.session.commit()
    return jsonify({'recording': rec.to_dict()}), 201
