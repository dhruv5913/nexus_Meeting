from flask_socketio import emit, join_room, leave_room
from flask import request
from models import db, Room
from datetime import datetime
import jwt, random, string
from config import Config

# Global state
active_users = {}       # sid -> {user_id, username, room_code, role}
room_participants = {}   # room_code -> {sid: {username, user_id, role, audio, video}}

def _ts():
    return datetime.utcnow().strftime('%H:%M')

def _decode(token):
    try:
        return jwt.decode(token, Config.JWT_SECRET, algorithms=['HS256'])
    except:
        return None

def _participants(code):
    if code not in room_participants:
        return []
    return [{'sid': s, **p} for s, p in room_participants[code].items()]

def register_connection_handlers(socketio):
    @socketio.on('connect')
    def on_connect():
        emit('connected', {'sid': request.sid})

    @socketio.on('authenticate')
    def on_auth(data):
        p = _decode(data.get('token', ''))
        if not p:
            emit('auth_error', {'message': 'Invalid token'})
            return
        active_users[request.sid] = {
            'user_id': p['user_id'], 'username': p['username'],
            'room_code': None, 'role': 'user'
        }
        emit('authenticated', {'username': p['username'], 'user_id': p['user_id']})

    @socketio.on('create_room')
    def on_create(data):
        if request.sid not in active_users:
            emit('error_message', {'message': 'Not authenticated'}); return
        u = active_users[request.sid]
        code = ''.join(random.choices(string.digits, k=6))
        room = Room(code=code, name=data.get('name', f"{u['username']}'s Room"), host_id=u['user_id'])
        db.session.add(room); db.session.commit()
        u['room_code'] = code; u['role'] = 'host'
        join_room(code)
        room_participants[code] = {
            request.sid: {'username': u['username'], 'user_id': u['user_id'],
                          'role': 'host', 'audio': True, 'video': True,
                          'screen_share_allowed': True, 'is_screen_sharing': False}
        }
        emit('room_created', {'room': room.to_dict(), 'participants': _participants(code), 'role': 'host'})
        emit('system_message', {'text': f"Room created — Code: {code}", 'timestamp': _ts()}, to=code)

    @socketio.on('join_room_request')
    def on_join(data):
        if request.sid not in active_users:
            emit('error_message', {'message': 'Not authenticated'}); return
        u = active_users[request.sid]
        code = data.get('room_code', '').strip()
        room = Room.query.filter_by(code=code, is_active=True).first()
        if not room:
            emit('error_message', {'message': 'Room not found'}); return
        if code not in room_participants:
            room_participants[code] = {}
        if len(room_participants[code]) >= room.max_participants:
            emit('error_message', {'message': 'Room full'}); return
        role = 'host' if room.host_id == u['user_id'] else 'user'
        u['room_code'] = code; u['role'] = role
        join_room(code)
        room_participants[code][request.sid] = {
            'username': u['username'], 'user_id': u['user_id'],
            'role': role, 'audio': True, 'video': True,
            'screen_share_allowed': role == 'host', 'is_screen_sharing': False
        }
        emit('room_joined', {'room': room.to_dict(), 'participants': _participants(code), 'role': role})
        emit('user_joined', {'sid': request.sid, 'username': u['username'],
                             'participants': _participants(code)}, to=code, include_self=False)
        emit('system_message', {'text': f"{u['username']} joined", 'timestamp': _ts()}, to=code)

    @socketio.on('leave_room_request')
    def on_leave():
        _cleanup(request.sid)

    @socketio.on('disconnect')
    def on_dc():
        _cleanup(request.sid)

    def _cleanup(sid):
        if sid not in active_users:
            return
        u = active_users[sid]
        code = u.get('room_code')
        if code and code in room_participants and sid in room_participants[code]:
            uname = room_participants[code][sid]['username']
            was_host = room_participants[code][sid]['role'] == 'host'
            del room_participants[code][sid]
            leave_room(code)
            if was_host and room_participants[code]:
                ns = next(iter(room_participants[code]))
                room_participants[code][ns]['role'] = 'host'
                if ns in active_users:
                    active_users[ns]['role'] = 'host'
                emit('host_changed', {'new_host_sid': ns,
                     'new_host_name': room_participants[code][ns]['username'],
                     'participants': _participants(code)}, to=code)
            emit('user_left', {'sid': sid, 'username': uname,
                               'participants': _participants(code)}, to=code)
            emit('system_message', {'text': f"{uname} left", 'timestamp': _ts()}, to=code)
            if not room_participants[code]:
                del room_participants[code]
                room = Room.query.filter_by(code=code).first()
                if room:
                    room.is_active = False
                    db.session.commit()
        if sid in active_users:
            del active_users[sid]
