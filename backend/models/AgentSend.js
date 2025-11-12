// backend/models/AgentSend.js
import mongoose from 'mongoose';

const AgentSendSchema = new mongoose.Schema(
  {
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Property',
      required: true,
      index: true,
    },
    agentEmail: {
      type: String,
      required: true,
      index: true,
      lowercase: true,
      trim: true,
    },
    subadminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    templateVersion: {
      type: String,
      default: 'agent_offer_v1',
    },
    status: {
      type: String,
      enum: ['queued', 'sent', 'bounced', 'failed', 'skipped'],
      default: 'queued',
      index: true,
    },
    reason: {
      type: String,
    },
    messageId: {
      type: String,
    },
  },
  {
    timestamps: true, // adds createdAt and updatedAt
  }
);

const AgentSend = mongoose.model('AgentSend', AgentSendSchema);
export default AgentSend;