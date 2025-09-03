import { Router } from 'express';
import { 
  getCities, 
  createCity, 
  updateCity, 
  deleteCity,
  getFaculties,
  createFaculty,
  getFacultyById,
  deleteFaculty,
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  getSubjects,
  createSubject,
  deleteSubject,
  getMaterials,
  createMaterial,
  updateMaterial,
  deleteMaterial,
  analyzeMaterial,
  getAnalysisStatus,
  getMaterialSections,
  getMaterialAnalysis,
  getMaterialTocAnalysis,
  updateMaterialField,
  updateDocumentSection,
  continueProcessingMaterial,
  deleteMaterialSections,
  resetTocProcessingStatus
} from '../controllers/materialController';
import { adminAuth } from '../middleware/adminAuth';

const router = Router();

// Apply admin authentication to all routes
router.use(adminAuth);

// Cities routes
router.get('/cities', getCities);
router.post('/cities', createCity);
router.put('/cities/:id', updateCity);
router.delete('/cities/:id', deleteCity);

// Faculties routes
router.get('/faculties', getFaculties);
router.post('/faculties', createFaculty);
router.get('/faculties/:id', getFacultyById);
router.delete('/faculties/:id', deleteFaculty);

// Departments routes
router.get('/departments', getDepartments);
router.post('/departments', createDepartment);
router.put('/departments/:id', updateDepartment);
router.delete('/departments/:id', deleteDepartment);

// Subjects routes
router.get('/subjects', getSubjects);
router.post('/subjects', createSubject);
router.delete('/subjects/:id', deleteSubject);

// Materials routes
router.get('/materials', getMaterials);
router.post('/materials', createMaterial);

// AI Analysis routes - specific routes MUST come before generic :id routes
router.post('/:id/analyze', analyzeMaterial);
router.get('/:id/analysis-status', getAnalysisStatus);
router.get('/:id/sections', getMaterialSections);
router.get('/:id/analysis', getMaterialAnalysis);
router.get('/:id/toc-analysis', getMaterialTocAnalysis);
router.put('/:id/field', updateMaterialField);
router.put('/section/:sectionId/field', updateDocumentSection);
router.delete('/:id/sections', deleteMaterialSections);
router.post('/:id/reset-toc-status', resetTocProcessingStatus);
router.post('/:id/continue-processing', continueProcessingMaterial);

// Generic material routes
router.put('/:id', updateMaterial);
router.delete('/:id', deleteMaterial);

export default router;