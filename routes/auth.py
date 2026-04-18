from flask import Blueprint, request, jsonify
import jwt, datetime
from models import db, User
from config import Config

auth_bp = Blueprint('auth', __name__)

def make_token(user):
    return jwt.encode(
        {'user_id': user.id, 'username': user.username,
         'exp': datetime.datetime.utcnow() + datetime.timedelta(seconds=Config.JWT_EXPIRY)},
        Config.JWT_SECRET, algorithm='HS256')

def verify_token(token):
    try:
        return jwt.decode(token, Config.JWT_SECRET, algorithms=['HS256'])
    except:
        return None

def get_current_user():
    ah = request.headers.get('Authorization', '')
    if not ah.startswith('Bearer '):
        return None
    p = verify_token(ah.split(' ')[1])
    return User.query.get(p['user_id']) if p else None

@auth_bp.route('/api/auth/register', methods=['POST'])
def register():
    d = request.get_json() or {}
    u, e, p = d.get('username','').strip(), d.get('email','').strip(), d.get('password','')
    if not u or not e or not p:
        return jsonify({'error': 'All fields required'}), 400
    if len(p) < 4:
        return jsonify({'error': 'Password too short'}), 400
    if User.query.filter_by(username=u).first():
        return jsonify({'error': 'Username taken'}), 400
    if User.query.filter_by(email=e).first():
        return jsonify({'error': 'Email taken'}), 400
    user = User(username=u, email=e)
    user.set_password(p)
    db.session.add(user)
    db.session.commit()
    return jsonify({'token': make_token(user), 'user': user.to_dict()}), 201

@auth_bp.route('/api/auth/login', methods=['POST'])
def login():
    d = request.get_json() or {}
    u, p = d.get('username','').strip(), d.get('password','')
    if not u or not p:
        return jsonify({'error': 'Credentials required'}), 400
    user = User.query.filter_by(username=u).first()
    if not user or not user.check_password(p):
        return jsonify({'error': 'Invalid credentials'}), 401
    return jsonify({'token': make_token(user), 'user': user.to_dict()})

@auth_bp.route('/api/auth/me')
def me():
    user = get_current_user()
    if not user:
        return jsonify({'error': 'Unauthorized'}), 401
    return jsonify({'user': user.to_dict()})
