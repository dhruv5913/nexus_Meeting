from flask_socketio import emit
from flask import request
from sockets.connection import active_users, room_participants

def register_call_handlers(socketio):
    @socketio.on('webrtc_offer')
    def on_offer(data):
        target = data.get('target_sid')
        if target:
            emit('webrtc_offer', {
                'offer': data['offer'], 'sender_sid': request.sid,
                'sender_name': active_users.get(request.sid, {}).get('username', '?')
            }, to=target)

    @socketio.on('webrtc_answer')
    def on_answer(data):
        target = data.get('target_sid')
        if target:
            emit('webrtc_answer', {
                'answer': data['answer'], 'sender_sid': request.sid
            }, to=target)

    @socketio.on('webrtc_ice')
    def on_ice(data):
        target = data.get('target_sid')
        if target:
            emit('webrtc_ice', {
                'candidate': data['candidate'], 'sender_sid': request.sid
            }, to=target)

    @socketio.on('join_call')
    def on_join_call(data):
        if request.sid not in active_users:
            return
        u = active_users[request.sid]
        code = u.get('room_code')
        if not code or code not in room_participants:
            return
        existing = [{'sid': s, 'username': p['username']}
                    for s, p in room_participants[code].items() if s != request.sid]
        emit('call_peers', {'peers': existing})
        emit('new_peer', {'sid': request.sid, 'username': u['username']},
             to=code, include_self=False)

    @socketio.on('leave_call')
    def on_leave_call(data):
        if request.sid not in active_users:
            return
        u = active_users[request.sid]
        code = u.get('room_code')
        if code:
            emit('peer_left', {'sid': request.sid, 'username': u['username']}, to=code)

    @socketio.on('toggle_audio')
    def on_toggle_audio(data):
        if request.sid not in active_users:
            return
        u = active_users[request.sid]
        code = u.get('room_code')
        enabled = data.get('enabled', True)
        if code and code in room_participants and request.sid in room_participants[code]:
            room_participants[code][request.sid]['audio'] = enabled
            emit('peer_audio_toggle', {'sid': request.sid, 'enabled': enabled}, to=code)

    @socketio.on('toggle_video')
    def on_toggle_video(data):
        if request.sid not in active_users:
            return
        u = active_users[request.sid]
        code = u.get('room_code')
        enabled = data.get('enabled', True)
        if code and code in room_participants and request.sid in room_participants[code]:
            room_participants[code][request.sid]['video'] = enabled
            emit('peer_video_toggle', {'sid': request.sid, 'enabled': enabled}, to=code)

    @socketio.on('active_speaker')
    def on_speaker(data):
        if request.sid not in active_users:
            return
        u = active_users[request.sid]
        code = u.get('room_code')
        if code:
            emit('speaker_update', {'sid': request.sid, 'level': data.get('level', 0)},
                 to=code, include_self=False)
