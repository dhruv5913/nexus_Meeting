from flask_socketio import emit
from flask import request
from models import db, Message, Room
from sockets.connection import active_users, room_participants
from datetime import datetime

def register_chat_handlers(socketio):
    @socketio.on('send_message')
    def on_msg(data):
        if request.sid not in active_users:
            return
        u = active_users[request.sid]
        code = u.get('room_code')
        if not code:
            return
        text = data.get('text', '').strip()
        if not text:
            return
        room = Room.query.filter_by(code=code).first()
        if room:
            msg = Message(room_id=room.id, user_id=u['user_id'],
                          username=u['username'], content=text)
            db.session.add(msg)
            db.session.commit()
            emit('receive_message', {
                'id': msg.id, 'username': u['username'],
                'content': text, 'user_id': u['user_id'],
                'timestamp': msg.created_at.strftime('%H:%M') if msg.created_at else ''
            }, to=code)
