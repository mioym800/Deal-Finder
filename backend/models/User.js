import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true },
  full_name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phone: { type: String, required: true },
  message: { type: String, default: '' },
  last_login: { type: Date },
  is_admin: { type: Boolean, default: false },
  role: { type: String, enum: ['admin', 'subadmin'], default: 'subadmin' },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
  deleted_at: { type: Date },  
  states: { type: [String], default: [] }
});

userSchema.pre('save', function(next) {
  if (!this.isModified('password')) {
    return next()
  }

  bcrypt.hash(this.password, 8, (err, hash) => {
    if (err) {
      return next(err)
    }

    this.password = hash
    next()
  })
})

userSchema.pre('findOneAndUpdate', async function(next) {
  const update = this.getUpdate();

  if (update.password) {
    update.password = await bcrypt.hash(update.password, 10);
    this.setUpdate(update);
  }

  next();
});

userSchema.methods.checkPassword = function(password) {
  const passwordHash = this.password
  return new Promise((resolve, reject) => {
    bcrypt.compare(password, passwordHash, (err, same) => {
      if (err) {
        return reject(err)
      }

      resolve(same)
    })
  })
}

userSchema.methods.isAdmin = function() {
  return this.role === 'admin' || this.is_admin === true;
}

userSchema.methods.canAccessState = function(stateCode) {
  if (this.isAdmin()) {
    return true;
  }
  return this.states.includes(stateCode);
}

const User = mongoose.model('User', userSchema);
export default User;