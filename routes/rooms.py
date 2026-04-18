from flask import Blueprint, request, jsonify
import random, string
from models import db, Room, Message
from routes.auth import get_current_user

rooms_bp = Blueprint('rooms', __name__)

@rooms_bp.route('/api/rooms', methods=['POST'])
def create_room():
    user = get_current_user()
    if not user:
        return jsonify({'error': 'Auth required'}), 401
    d = request.get_json() or {}
    code = ''.join(random.choices(string.digits, k=6))
    room = Room(code=code, name=d.get('name', f"{user.username}'s Room"), host_id=user.id)
    db.session.add(room)
    db.session.commit()
    return jsonify({'room': room.to_dict()}), 201

@rooms_bp.route('/api/rooms/<code>')
def get_room(code):
    room = Room.query.filter_by(code=code, is_active=True).first()
    if not room:
        return jsonify({'error': 'Not found'}), 404
    return jsonify({'room': room.to_dict()})

@rooms_bp.route('/api/rooms/<code>/messages')
def get_messages(code):
    room = Room.query.filter_by(code=code).first()
    if not room:
        return jsonify({'error': 'Not found'}), 404
    msgs = Message.query.filter_by(room_id=room.id).order_by(Message.created_at.asc()).limit(200).all()
    return jsonify({'messages': [m.to_dict() for m in msgs]})
