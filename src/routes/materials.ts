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
  deleteSubject
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

export default router;