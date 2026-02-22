import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sileo } from 'sileo';
import { CreateProjectScreen } from '../components/CreateProjectScreen';
import { LazySettingsToggle } from '../components/LazySettingsToggle';
import { projectService } from '../services/api';

export const CreateProjectPage: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const handleGenerate = async (data: {
    title: string;
    youtubeUrl: string;
    visualStyle: string;
    aspectRatio: '16:9' | '9:16' | '1:1';
  }) => {
    setLoading(true);

    try {
      const project = await projectService.create(
        data.youtubeUrl,
        data.title,
        data.visualStyle,
        data.aspectRatio,
      );
      await projectService.startGeneration(project.id, data.visualStyle);
      navigate(`/project/${project.id}`);
    } catch (err) {
      sileo.error({
        title: 'Project creation failed',
        description: 'Please check the YouTube URL and try again.',
      });
      console.error(err);
      setLoading(false);
    }
  };

  return (
    <>
      <div className="fixed top-6 right-6 z-50">
        <LazySettingsToggle />
      </div>

      <CreateProjectScreen onGenerate={handleGenerate} />

      {loading && (
        <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center">
          <div className="text-center space-y-4">
            <div className="w-16 h-16 border-4 border-stitch-cyan border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-white font-bold text-lg">Initializing Pipeline...</p>
            <p className="text-gray-500 text-sm">Setting up your project</p>
          </div>
        </div>
      )}
    </>
  );
};
