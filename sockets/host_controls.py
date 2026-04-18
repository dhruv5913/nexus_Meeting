from flask_socketio import emit
from flask import request
from sockets.connection import active_users, room_participants

def register_host_handlers(socketio):
    def _is_host(sid):
        if sid not in active_users:
            return False, None
        u = active_users[sid]
        return u.get('role') in ('host', 'cohost'), u.get('room_code')

    def _get_host_sid(code):
        """Find the host's socket ID for a room."""
        if code not in room_participants:
            return None
        for sid, p in room_participants[code].items():
            if p.get('role') == 'host':
                return sid
        return None

    def _participants(code):
        if code not in room_participants:
            return []
        return [{'sid': s, **p} for s, p in room_participants[code].items()]

    # ===== EXISTING HOST CONTROLS =====

    @socketio.on('kick_user')
    def on_kick(data):
        ok, code = _is_host(request.sid)
        if not ok or not code:
            emit('error_message', {'message': 'Not authorized'}); return
        tsid = data.get('target_sid')
        if tsid and code in room_participants and tsid in room_participants[code]:
            uname = room_participants[code][tsid]['username']
            emit('kicked', {'message': 'You were removed by the host'}, to=tsid)
            del room_participants[code][tsid]
            if tsid in active_users:
                active_users[tsid]['room_code'] = None
            emit('user_left', {'sid': tsid, 'username': uname,
                               'participants': _participants(code)}, to=code)
            emit('system_message', {'text': f"{uname} was removed by host"}, to=code)

    @socketio.on('mute_user')
    def on_mute(data):
        ok, code = _is_host(request.sid)
        if not ok or not code:
            return
        tsid = data.get('target_sid')
        if tsid and code in room_participants and tsid in room_participants[code]:
            room_participants[code][tsid]['audio'] = False
            emit('force_mute', {'by': active_users[request.sid]['username']}, to=tsid)
            emit('peer_audio_toggle', {'sid': tsid, 'enabled': False}, to=code)

    @socketio.on('disable_video_user')
    def on_disable_vid(data):
        ok, code = _is_host(request.sid)
        if not ok or not code:
            return
        tsid = data.get('target_sid')
        if tsid and code in room_participants and tsid in room_participants[code]:
            room_participants[code][tsid]['video'] = False
            emit('force_video_off', {'by': active_users[request.sid]['username']}, to=tsid)
            emit('peer_video_toggle', {'sid': tsid, 'enabled': False}, to=code)

    @socketio.on('end_call_all')
    def on_end_all():
        ok, code = _is_host(request.sid)
        if not ok or not code:
            return
        emit('call_ended_by_host', {}, to=code)
        emit('system_message', {'text': 'Host ended the call for everyone'}, to=code)

    # ===== SCREEN SHARE PERMISSION SYSTEM =====

    @socketio.on('screen_share_request')
    def on_screen_share_request():
        """User requests permission from host to share their screen."""
        if request.sid not in active_users:
            return
        u = active_users[request.sid]
        code = u.get('room_code')
        if not code or code not in room_participants:
            return
        # If user already has permission, just tell them
        if request.sid in room_participants[code]:
            if room_participants[code][request.sid].get('screen_share_allowed'):
                emit('screen_share_approved', {'message': 'You already have permission'})
                return
        # Find host and send them the request
        host_sid = _get_host_sid(code)
        if host_sid:
            emit('screen_share_request_received', {
                'requester_sid': request.sid,
                'requester_name': u['username']
            }, to=host_sid)
            emit('system_message', {
                'text': f"{u['username']} is requesting to share their screen"
            }, to=host_sid)
        else:
            emit('error_message', {'message': 'No host found in room'})

    @socketio.on('screen_share_respond')
    def on_screen_share_respond(data):
        """Host approves or rejects a screen share request."""
        ok, code = _is_host(request.sid)
        if not ok or not code:
            emit('error_message', {'message': 'Not authorized'}); return
        tsid = data.get('target_sid')
        approved = data.get('approved', False)
        if not tsid or code not in room_participants or tsid not in room_participants[code]:
            return
        uname = room_participants[code][tsid]['username']
        if approved:
            room_participants[code][tsid]['screen_share_allowed'] = True
            emit('screen_share_approved', {
                'message': 'Host approved your screen share request'
            }, to=tsid)
            emit('participants_updated', {
                'participants': _participants(code)
            }, to=code)
            emit('system_message', {
                'text': f"Host allowed {uname} to share screen"
            }, to=code)
        else:
            emit('screen_share_rejected', {
                'message': 'Host rejected your screen share request'
            }, to=tsid)

    @socketio.on('grant_screen_share')
    def on_grant_screen_share(data):
        """Host proactively grants screen share permission to a user."""
        ok, code = _is_host(request.sid)
        if not ok or not code:
            return
        tsid = data.get('target_sid')
        if tsid and code in room_participants and tsid in room_participants[code]:
            room_participants[code][tsid]['screen_share_allowed'] = True
            uname = room_participants[code][tsid]['username']
            emit('screen_share_permission_changed', {
                'allowed': True,
                'message': 'Host granted you screen share permission'
            }, to=tsid)
            emit('participants_updated', {
                'participants': _participants(code)
            }, to=code)
            emit('system_message', {
                'text': f"Host granted screen share to {uname}"
            }, to=code)

    @socketio.on('revoke_screen_share')
    def on_revoke_screen_share(data):
        """Host revokes screen share permission from a user."""
        ok, code = _is_host(request.sid)
        if not ok or not code:
            return
        tsid = data.get('target_sid')
        if tsid and code in room_participants and tsid in room_participants[code]:
            room_participants[code][tsid]['screen_share_allowed'] = False
            was_sharing = room_participants[code][tsid].get('is_screen_sharing', False)
            uname = room_participants[code][tsid]['username']
            if was_sharing:
                room_participants[code][tsid]['is_screen_sharing'] = False
                emit('force_stop_screen_share', {
                    'by': active_users[request.sid]['username']
                }, to=tsid)
                emit('peer_screen_share_stopped', {
                    'sid': tsid, 'username': uname
                }, to=code)
            emit('screen_share_permission_changed', {
                'allowed': False,
                'message': 'Host revoked your screen share permission'
            }, to=tsid)
            emit('participants_updated', {
                'participants': _participants(code)
            }, to=code)
            emit('system_message', {
                'text': f"Host revoked screen share from {uname}"
            }, to=code)

    @socketio.on('start_screen_share')
    def on_start_screen_share():
        """User notifies the room they started sharing their screen."""
        if request.sid not in active_users:
            return
        u = active_users[request.sid]
        code = u.get('room_code')
        if not code or code not in room_participants or request.sid not in room_participants[code]:
            return
        p = room_participants[code][request.sid]
        # Host can always share; users need permission
        if p['role'] != 'host' and not p.get('screen_share_allowed', False):
            emit('error_message', {'message': 'You need permission to share screen'})
            return
        # Check if someone else is already sharing
        for sid, participant in room_participants[code].items():
            if sid != request.sid and participant.get('is_screen_sharing', False):
                emit('error_message', {'message': f"{participant['username']} is already sharing"})
                return
        p['is_screen_sharing'] = True
        emit('peer_screen_sharing', {
            'sid': request.sid,
            'username': u['username'],
            'sharing': True
        }, to=code)

    @socketio.on('stop_screen_share')
    def on_stop_screen_share():
        """User stopped sharing their screen."""
        if request.sid not in active_users:
            return
        u = active_users[request.sid]
        code = u.get('room_code')
        if not code or code not in room_participants or request.sid not in room_participants[code]:
            return
        room_participants[code][request.sid]['is_screen_sharing'] = False
        emit('peer_screen_share_stopped', {
            'sid': request.sid,
            'username': u['username']
        }, to=code)

    @socketio.on('force_stop_user_screen_share')
    def on_force_stop(data):
        """Host force-stops a user's screen share."""
        ok, code = _is_host(request.sid)
        if not ok or not code:
            return
        tsid = data.get('target_sid')
        if tsid and code in room_participants and tsid in room_participants[code]:
            room_participants[code][tsid]['is_screen_sharing'] = False
            uname = room_participants[code][tsid]['username']
            emit('force_stop_screen_share', {
                'by': active_users[request.sid]['username']
            }, to=tsid)
            emit('peer_screen_share_stopped', {
                'sid': tsid, 'username': uname
            }, to=code)
            emit('system_message', {
                'text': f"Host stopped {uname}'s screen share"
            }, to=code)
