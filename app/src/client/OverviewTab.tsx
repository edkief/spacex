import React, { useState, useEffect } from 'react';
import { Livery } from '../shared/ships';

interface OverviewTabProps {
  initialLivery: Livery;
  onUpdate: (livery: Livery) => void;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({ initialLivery, onUpdate }) => {
  const [livery, setLivery] = useState<Livery>(initialLivery);
  const [saving, setSaving] = useState(false);

  const handleChange = (field: keyof Livery, value: string) => {
    const next = { ...livery, [field]: value };
    setLivery(next);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await fetch('/api/ships/livery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(livery),
      });

      if (response.ok) {
        onUpdate(livery);
      } else {
        const err = await response.json();
        alert(`Error saving livery: ${err.message}`);
      }
    } catch (e) {
      alert('Network error while saving livery');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        padding: '20px',
        background: 'rgba(0, 0, 0, 0.7)',
        color: '#fff',
        borderRadius: '8px',
        width: '300px',
        border: '1px solid #444',
        pointerEvents: 'auto',
      }}
    >
      <h2 style={{ marginTop: 0 }}>Ship Customization</h2>

      <div style={{ marginBottom: '15px' }}>
        <label style={{ display: 'block', marginBottom: '5px' }}>Hull Color</label>
        <input
          type="color"
          value={livery.hull}
          onChange={(e) => handleChange('hull', e.target.value)}
          style={{ width: '100%' }}
        />
      </div>

      <div style={{ marginBottom: '15px' }}>
        <label style={{ display: 'block', marginBottom: '5px' }}>Accent Color</label>
        <input
          type="color"
          value={livery.accent}
          onChange={(e) => handleChange('accent', e.target.value)}
          style={{ width: '100%' }}
        />
      </div>

      <div style={{ marginBottom: '15px' }}>
        <label style={{ display: 'block', marginBottom: '5px' }}>Trim Color</label>
        <input
          type="color"
          value={livery.trim}
          onChange={(e) => handleChange('trim', e.target.value)}
          style={{ width: '100%' }}
        />
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          width: '100%',
          padding: '10px',
          background: '#007bff',
          color: '#fff',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
          opacity: saving ? 0.5 : 1,
        }}
      >
        {saving ? 'Saving...' : 'Apply Livery'}
      </button>
    </div>
  );
};
