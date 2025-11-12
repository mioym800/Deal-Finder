import User from '../models/User.js';
import { log } from '../utils/logger.js';
import axios from 'axios';
// Mark a property as a deal and enrich agent info
const markPropertyAsDeal = async (property) => {
  L.info('Marking property as deal', { propertyId: property._id });
  property.status = 'deal';
  await property.save();
  try {
    await axios.post(
      'http://localhost:5001/agent/enrich',
      {
        propertyId: property._id,
        fullAddress: property.fullAddress
      }
    );
    L.success('Agent enrichment triggered', { propertyId: property._id });
  } catch (err) {
    L.error('Agent enrichment failed', { propertyId: property._id, error: err.message });
  }
};

const L = log.child('user');

// Create a new user
const createUser = async (userData) => {
  try {
    const existingUser = await User.findOne({ email: userData.email });

    if (existingUser) {
      L.warn('User already exists', { email: userData.email, id: existingUser._id });
      return existingUser;
    }

    const user = new User({ ...userData });
    await user.save();
    L.success('User saved', { id: user._id, email: user.email });
    return user;
  } catch (error) {
    L.error('Error saving user', { email: userData?.email, error: error.message });
    throw error;
  }
};

// Read all users
const getUsers = async () => {
  try {
    L.info('Fetching users');
    const users = await User.find();
    L.success('Users retrieved', { count: users.length });
    return users;
  } catch (error) {
    L.error('Error retrieving users', { error: error.message });
    throw error;
  }
};

// Retrieve a user whose `states` array includes the given state code.
const getUserByState = async (stateCode) => {
  try {
    L.info('Fetching user by state', { state: stateCode });
    // Match any user whose states array contains the specified code
    const user = await User.findOne({ states: stateCode });
    if (!user) {
      L.warn('No user found for state', { state: stateCode });
      return null;
    }
    L.success('User retrieved for state', { state: stateCode, user: user.full_name, id: user._id });
    return user;
  } catch (error) {
    L.error(`Error retrieving user for state`, { state: stateCode, error: error.message });
    throw error;
  }
};

// Update a user by ID
const updateUser = async (id, updatedData) => {
  try {
    L.info('Updating user', { id });
    const user = await User.findByIdAndUpdate(id, updatedData, { new: true });
    if (!user) {
      L.warn('User not found to update', { id });
      return null;
    }
    L.success('User updated', { id, email: user.email });
    return user;
  } catch (error) {
    L.error('Error updating user', { id, error: error.message });
    throw error;
  }
};

// Delete a user by ID
const deleteUser = async (id) => {
  try {
    L.info('Deleting user', { id });
    await User.findByIdAndDelete(id);
    L.success('User deleted', { id });
  } catch (error) {
    L.error('Error deleting user', { id, error: error.message });
    throw error;
  }
};

export {
  createUser,
  getUsers,
  updateUser,
  deleteUser,
  getUserByState,
  markPropertyAsDeal
};